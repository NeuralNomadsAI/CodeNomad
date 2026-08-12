import {
  OpenCode,
  type LocationGetOutput,
  type LocationRef,
  type OpenCodeClient,
  type OpenCodeEvent,
} from "@opencode-ai/client"
import { Service, type Endpoint, type EnsureOptions, type Info, type StopOptions } from "@opencode-ai/client/service"
import { readFile } from "node:fs/promises"

type RequestOptions = { signal?: AbortSignal }
export type OpenCodeEnsureOptions = EnsureOptions & { environment?: NodeJS.ProcessEnv }

interface ServiceConnection {
  endpoint: Endpoint
  client: OpenCodeClient
  stopOptions: StopOptions
}

export interface OpenCodeSharedServiceDependencies {
  discover: typeof Service.discover
  ensure: typeof Service.ensure
  headers: typeof Service.headers
  stop: typeof Service.stop
  makeClient: typeof OpenCode.make
}

export class OpenCodeSharedService {
  private connection?: Promise<ServiceConnection>
  private connected?: ServiceConnection
  private healthCheck?: Promise<ServiceConnection>
  private ensureOptions?: OpenCodeEnsureOptions
  private owned?: { stopOptions: StopOptions; info: Info }
  private shutdownAttempt?: Promise<void>

  constructor(private readonly dependencies: OpenCodeSharedServiceDependencies = {
    discover: Service.discover,
    ensure: Service.ensure,
    headers: Service.headers,
    stop: Service.stop,
    makeClient: OpenCode.make,
  }) {}

  endpoint(options?: OpenCodeEnsureOptions): Promise<Endpoint> {
    return this.connect(options).then(({ endpoint }) => endpoint)
  }

  client(options?: OpenCodeEnsureOptions): Promise<OpenCodeClient> {
    return this.connect(options).then(({ client }) => client)
  }

  async headers(options?: OpenCodeEnsureOptions): Promise<ReturnType<typeof Service.headers>> {
    return this.dependencies.headers(await this.endpoint(options))
  }

  async validateLocation(
    location: LocationRef,
    requestOptions?: RequestOptions,
    ensureOptions?: OpenCodeEnsureOptions,
  ): Promise<LocationGetOutput> {
    const result = await this.withClient(ensureOptions, (client) => client.location.get({
      location: { directory: location.directory, workspace: location.workspaceID },
    }, requestOptions))
    if (
      !result
      || typeof result.directory !== "string"
      || typeof result.project?.id !== "string"
      || typeof result.project.directory !== "string"
      || typeof result.project.canonical !== "string"
    ) {
      throw new Error("OpenCode returned an invalid location")
    }
    return result
  }

  async subscribe(requestOptions?: RequestOptions, ensureOptions?: OpenCodeEnsureOptions): Promise<AsyncIterable<OpenCodeEvent>> {
    let connection: ServiceConnection | undefined
    try {
      connection = await this.connect(ensureOptions)
      const events = connection.client.event.subscribe(requestOptions)
      return this.invalidateAfterStream(events, connection)
    } catch (error) {
      if (connection) this.invalidateConnection(connection)
      throw error
    }
  }

  async evict(
    location: LocationRef,
    requestOptions?: RequestOptions,
    ensureOptions?: OpenCodeEnsureOptions,
  ): Promise<void> {
    await this.withClient(ensureOptions, (client) => client.debug.location.evict({
      location: { directory: location.directory, workspace: location.workspaceID },
    }, requestOptions))
  }

  shutdown(): Promise<void> {
    if (this.shutdownAttempt) return this.shutdownAttempt
    const attempt = this.stopOwnedService().finally(() => {
      if (this.shutdownAttempt === attempt) this.shutdownAttempt = undefined
    })
    this.shutdownAttempt = attempt
    return attempt
  }

  private async stopOwnedService(): Promise<void> {
    const owned = this.owned
    if (!owned) return
    const current = await this.readInfo(owned.stopOptions.file).catch(() => undefined)
    // ponytail: uncertain discovery retains ownership for a later shutdown retry.
    if (!current) return
    if (!this.sameInfo(current, owned.info)) return
    await this.dependencies.stop(owned.stopOptions)
    if (this.owned === owned) this.owned = undefined
    this.clear()
  }

  private connect(options?: OpenCodeEnsureOptions): Promise<ServiceConnection> {
    const selectedOptions = options ?? this.ensureOptions ?? {}
    if (!this.connected) return this.connection ?? this.startConnection(selectedOptions)
    if (this.healthCheck) return this.healthCheck

    const current = this.connection!
    const { environment: _environment, onStart: _onStart, command: _command, ...discoverOptions } = selectedOptions
    const check = this.dependencies.discover(discoverOptions).then((endpoint) => {
      if (endpoint && this.sameEndpoint(endpoint, this.connected!.endpoint)) return this.connected!
      this.invalidate(current)
      return this.startConnection(selectedOptions)
    }, () => {
      this.invalidate(current)
      return this.startConnection(selectedOptions)
    })
    const healthCheck = check.finally(() => {
      if (this.healthCheck === healthCheck) this.healthCheck = undefined
    })
    this.healthCheck = healthCheck
    return healthCheck
  }

  private startConnection(options: OpenCodeEnsureOptions): Promise<ServiceConnection> {
    this.ensureOptions = options
    const { environment, ...ensureOptions } = options
    const onStart = ensureOptions.onStart
    const pending = this.withEnvironment(environment, () => this.dependencies.ensure({
      ...ensureOptions,
      onStart: (reason, previousVersion) => {
        onStart?.(reason, previousVersion)
      },
    })).then((endpoint) => {
      const url = new URL(endpoint.url)
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`Unsupported OpenCode service protocol: ${url.protocol}`)
      }
      const connection = {
        endpoint,
        stopOptions: { file: ensureOptions.file },
        client: this.dependencies.makeClient({
          baseUrl: endpoint.url,
          headers: this.dependencies.headers(endpoint),
        }),
      }
      const contenderFile = environment?.CODENOMAD_SERVICE_CONTENDERS
      return this.proveOwnership(connection.stopOptions.file, contenderFile).then((info) => {
        if (info) {
          this.owned = { stopOptions: connection.stopOptions, info }
        }
        this.connected = connection
        return connection
      })
    })
    const connection = pending.catch((error) => {
      this.invalidate(connection)
      throw error
    })
    this.connection = connection
    return connection
  }

  private async withClient<T>(
    options: OpenCodeEnsureOptions | undefined,
    run: (client: OpenCodeClient) => Promise<T>,
  ): Promise<T> {
    let connection: ServiceConnection | undefined
    try {
      connection = await this.connect(options)
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

  private invalidate(pending: Promise<ServiceConnection>): void {
    if (this.connection !== pending) return
    this.clear()
  }

  private clear(): void {
    this.connection = undefined
    this.connected = undefined
    this.healthCheck = undefined
  }

  private sameEndpoint(left: Endpoint, right: Endpoint): boolean {
    return left.url === right.url
      && left.auth?.username === right.auth?.username
      && left.auth?.password === right.auth?.password
  }

  private async proveOwnership(file: string | undefined, contenderFile: string | undefined): Promise<Info | undefined> {
    if (!file || !contenderFile) return undefined
    const [info, contenders] = await Promise.all([
      this.readInfo(file).catch(() => undefined),
      readFile(contenderFile, "utf8").catch(() => ""),
    ])
    if (!info || !contenders.split(/\r?\n/).includes(String(info.pid))) return undefined
    return info
  }

  private async readInfo(file: string | undefined): Promise<Info | undefined> {
    if (!file) return undefined
    const value: unknown = JSON.parse(await readFile(file, "utf8"))
    if (typeof value !== "object" || value === null) return undefined
    if (!("url" in value) || typeof value.url !== "string") return undefined
    if (!("id" in value) || typeof value.id !== "string" || !value.id) return undefined
    if (!("pid" in value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return undefined
    return value as Info
  }

  private sameInfo(left: Info, right: Info): boolean {
    return left.id === right.id
      && left.version === right.version
      && left.url === right.url
      && left.pid === right.pid
      && left.password === right.password
  }

  private async withEnvironment<T>(environment: NodeJS.ProcessEnv | undefined, run: () => Promise<T>): Promise<T> {
    const entries = Object.entries(environment ?? {})
    if (!entries.length) return run()

    // ponytail: Service.ensure has no env option, so overlay only for its one
    // shared launch and restore immediately. Replace when the SDK accepts env.
    const previous = new Map(entries.map(([key]) => [key, process.env[key]]))
    for (const [key, value] of entries) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    try {
      return await run()
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
}
