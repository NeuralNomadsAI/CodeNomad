import {
  OpenCode,
  type LocationGetOutput,
  type LocationRef,
  type OpenCodeClient,
  type OpenCodeEvent,
} from "@opencode-ai/client"
import { Service, type Endpoint } from "@opencode-ai/client/service"
import { assertLoopbackServiceUrl } from "./service-state"

type RequestOptions = { signal?: AbortSignal; deadlineAt?: number }
const CONNECTION_RECHECK_INTERVAL_MS = 30_000

export interface OpenCodeServiceLifecycle {
  discover: (deadlineAt?: number) => Promise<Endpoint | undefined>
  ensure: (deadlineAt?: number) => Promise<Endpoint>
}

export type OpenCodeSharedServiceOptions = {
  kind: "lifecycle"
  identity: string
  lifecycle: OpenCodeServiceLifecycle
}

interface ServiceConnection {
  endpoint: Endpoint
  client: OpenCodeClient
}

export interface OpenCodeSharedServiceDependencies {
  headers: typeof Service.headers
  makeClient: typeof OpenCode.make
  now?: () => number
}

export class OpenCodeSharedService {
  private connection?: Promise<ServiceConnection>
  private connected?: ServiceConnection
  private healthCheck?: Promise<ServiceConnection>
  private serviceOptions?: OpenCodeSharedServiceOptions
  private serviceIdentity?: string
  private hasValidatedConnection = false
  private readonly now: () => number
  private connectionValidatedAt?: number
  private generation = 0

  constructor(private readonly dependencies: OpenCodeSharedServiceDependencies = {
    headers: Service.headers,
    makeClient: OpenCode.make,
  }) {
    this.now = dependencies.now ?? Date.now
  }

  endpoint(options?: OpenCodeSharedServiceOptions, requestOptions?: RequestOptions): Promise<Endpoint> {
    return this.connect(options, requestOptions?.deadlineAt).then(({ endpoint }) => endpoint)
  }

  client(options?: OpenCodeSharedServiceOptions, requestOptions?: RequestOptions): Promise<OpenCodeClient> {
    return this.connect(options, requestOptions?.deadlineAt).then(({ client }) => client)
  }

  async headers(options?: OpenCodeSharedServiceOptions, requestOptions?: RequestOptions): Promise<ReturnType<typeof Service.headers>> {
    return this.dependencies.headers(await this.endpoint(options, requestOptions))
  }

  async validateLocation(
    location: LocationRef,
    requestOptions?: RequestOptions,
    serviceOptions?: OpenCodeSharedServiceOptions,
  ): Promise<LocationGetOutput> {
    const result = await this.withClient(serviceOptions, (client) => client.location.get({
      location: {
        directory: location.directory,
        ...(location.workspaceID ? { workspace: location.workspaceID } : {}),
      },
    }, requestOptions?.signal ? { signal: requestOptions.signal } : undefined), requestOptions)
    if (
      !result
      || typeof result.directory !== "string"
      || typeof result.project?.id !== "string"
      || typeof result.project.directory !== "string"
      || typeof result.project.canonical !== "string"
    ) {
      throw new Error("OpenCode returned an invalid location")
    }
    if (location.workspaceID && result.workspaceID !== location.workspaceID) {
      throw new Error("OpenCode location workspace does not match the canonical location")
    }
    return result
  }

  async evictLocation(
    location: LocationRef,
    requestOptions?: RequestOptions,
    serviceOptions?: OpenCodeSharedServiceOptions,
  ): Promise<void> {
    await this.withClient(serviceOptions, (client) => client.debug.location.evict({
      location: {
        directory: location.directory,
        ...(location.workspaceID ? { workspace: location.workspaceID } : {}),
      },
    }, requestOptions?.signal ? { signal: requestOptions.signal } : undefined), requestOptions)
  }

  async subscribe(requestOptions?: RequestOptions, serviceOptions?: OpenCodeSharedServiceOptions): Promise<AsyncIterable<OpenCodeEvent>> {
    let connection: ServiceConnection | undefined
    try {
      connection = await this.connect(serviceOptions, requestOptions?.deadlineAt)
      const nativeRequestOptions = requestOptions?.signal ? { signal: requestOptions.signal } : undefined
      return this.invalidateAfterStream(connection.client.event.subscribe(nativeRequestOptions), connection)
    } catch (error) {
      if (connection) this.invalidateConnection(connection)
      throw error
    }
  }

  async shutdown(): Promise<void> {
    this.generation += 1
    this.clear()
    this.serviceOptions = undefined
    this.serviceIdentity = undefined
    this.hasValidatedConnection = false
  }

  invalidate(): void {
    this.generation += 1
    this.clear()
  }

  private connect(options?: OpenCodeSharedServiceOptions, deadlineAt?: number): Promise<ServiceConnection> {
    try {
      this.pinServiceOptions(options)
    } catch (error) {
      return Promise.reject(error)
    }
    if (!this.connected) return this.connection ?? this.startConnection(deadlineAt)
    if (this.healthCheck) return this.healthCheck

    const current = this.connected
    if (
      this.connectionValidatedAt !== undefined
      && this.now() - this.connectionValidatedAt < CONNECTION_RECHECK_INTERVAL_MS
    ) {
      return Promise.resolve(current)
    }
    const check = this.lifecycle().discover(deadlineAt).then((endpoint) => {
      if (endpoint && this.sameEndpoint(endpoint, current.endpoint)) {
        this.connectionValidatedAt = this.now()
        return current
      }
      this.invalidateConnection(current)
      return endpoint ? this.createConnection(endpoint, this.generation) : this.startConnection(deadlineAt)
    }, () => {
      this.invalidateConnection(current)
      return this.startConnection(deadlineAt)
    })
    const healthCheck = check.finally(() => {
      if (this.healthCheck === healthCheck) this.healthCheck = undefined
    })
    this.healthCheck = healthCheck
    return healthCheck
  }

  private startConnection(deadlineAt?: number): Promise<ServiceConnection> {
    const generation = this.generation
    const lifecycle = this.lifecycle()
    const startup = lifecycle.discover(deadlineAt)
      .then((endpoint) => endpoint ?? lifecycle.ensure(deadlineAt))
      .then((endpoint) => this.createConnection(endpoint, generation))
    const connection = startup.catch((error) => {
      if (this.connection === connection) {
        this.clear()
        if (!this.hasValidatedConnection) {
          this.serviceOptions = undefined
          this.serviceIdentity = undefined
        }
      }
      throw error
    })
    this.connection = connection
    return connection
  }

  private createConnection(endpoint: Endpoint, generation: number): ServiceConnection {
    const wildcard = new URL(endpoint.url).hostname === "0.0.0.0"
    const url = assertLoopbackServiceUrl(endpoint.url)
    if (wildcard) endpoint = { ...endpoint, url: url.toString() }
    const connection = {
      endpoint,
      client: this.dependencies.makeClient({
        baseUrl: endpoint.url,
        headers: this.dependencies.headers(endpoint),
      }),
    }
    if (generation === this.generation) {
      this.hasValidatedConnection = true
      this.connected = connection
      this.connection = Promise.resolve(connection)
      this.connectionValidatedAt = this.now()
    }
    return connection
  }

  private async withClient<T>(
    options: OpenCodeSharedServiceOptions | undefined,
    run: (client: OpenCodeClient) => Promise<T>,
    requestOptions?: RequestOptions,
  ): Promise<T> {
    let connection: ServiceConnection | undefined
    try {
      connection = await this.connect(options, requestOptions?.deadlineAt)
      return await run(connection.client)
    } catch (error) {
      if (connection) this.invalidateConnection(connection)
      throw error
    }
  }

  private async *invalidateAfterStream(events: AsyncIterable<OpenCodeEvent>, connection: ServiceConnection) {
    try {
      yield* events
    } finally {
      this.invalidateConnection(connection)
    }
  }

  private invalidateConnection(connection: ServiceConnection): void {
    if (this.connected === connection) this.clear()
  }

  private clear(): void {
    this.connection = undefined
    this.connected = undefined
    this.healthCheck = undefined
    this.connectionValidatedAt = undefined
  }

  private sameEndpoint(left: Endpoint, right: Endpoint): boolean {
    return left.url === right.url
      && left.auth?.username === right.auth?.username
      && left.auth?.password === right.auth?.password
  }

  private lifecycle(): OpenCodeServiceLifecycle {
    if (!this.serviceOptions) throw new Error("OpenCode service lifecycle has not been configured")
    return this.serviceOptions.lifecycle
  }

  private pinServiceOptions(options?: OpenCodeSharedServiceOptions): void {
    const identity = options ? serviceIdentity(options) : this.serviceIdentity
    if (!identity) throw new Error("OpenCode service lifecycle has not been configured")
    if (this.serviceIdentity && this.serviceIdentity !== identity) {
      throw new Error(`OpenCode service identity cannot change from ${this.serviceIdentity} to ${identity}`)
    }
    if (this.serviceIdentity) return
    this.serviceIdentity = identity
    this.serviceOptions = options
  }
}

function serviceIdentity(options: OpenCodeSharedServiceOptions): string {
  const identity = options.identity.trim()
  if (!identity) throw new Error("OpenCode service lifecycle identity must not be empty")
  return `lifecycle:${identity}`
}
