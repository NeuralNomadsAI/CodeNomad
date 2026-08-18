import {
  OpenCode,
  type LocationGetOutput,
  type LocationRef,
  type OpenCodeClient,
  type OpenCodeEvent,
} from "@opencode-ai/client"
import { Service, type Endpoint, type EnsureOptions, type Info, type StopOptions } from "@opencode-ai/client/service"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import { appendFile, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import {
  getProcessStartIdentity,
  probeProcessStartIdentity,
  type ProcessIdentity,
  type ProcessNamespace,
} from "./process-identity"
import { assertLoopbackServiceUrl, readSecureServiceInfo } from "./service-state"

type RequestOptions = { signal?: AbortSignal }
type ServiceProof = {
  info: Info
  endpoint: Endpoint
  registrationFile: string
  nativePid?: boolean
  processIdentity?: ProcessIdentity
  launchSignature?: string
}
interface LaunchIntent {
  identity: string
  createdAt: number
  nativePid: boolean
  contenderFile?: string
  servicePid?: number
}
type LeaseState = "active" | "stopping"
interface LeaseMetadata {
  version: 1
  identity: string
  pid: number
  processIdentity: ProcessIdentity
  createdAt: number
  updatedAt: number
  state: LeaseState
  contenderFile?: string
  launch?: LaunchIntent
  service?: ServiceProof
  launchSignature?: string
}
interface LockOwner {
  version: 1
  identity: string
  pid: number
  processIdentity: ProcessIdentity
  createdAt: number
}
interface LeaseHandle {
  file: string
  lockDirectory: string
  contenderFile?: string
  identity: string
  staleLockMs: number
  lifecycleTimeoutMs: number
}

const DEFAULT_STALE_LOCK_MS = 30_000
const LOCK_OWNER_FILE = "owner.json"

export type OpenCodeEnsureOptions = EnsureOptions & {
  contenderFile?: string
  leaseFile?: string
  lockDirectory?: string
  timeoutMs?: number
  staleLockMs?: number
  nativePid?: boolean
  wslDistro?: string
  environment?: NodeJS.ProcessEnv
  launcherRecordsPid?: boolean
  windowsVerbatimArguments?: boolean
}

interface ServiceConnection {
  endpoint: Endpoint
  client: OpenCodeClient
  stopOptions: StopOptions
  launchSignature: string
}

interface OwnedService {
  stopOptions: StopOptions
  info: Info
  endpoint: Endpoint
  nativePid: boolean
  processIdentity?: ProcessIdentity
  launchSignature: string
}

export interface OpenCodeSharedServiceDependencies {
  discover: typeof Service.discover
  ensure?: typeof Service.ensure
  stop?: typeof Service.stop
  headers: typeof Service.headers
  makeClient: typeof OpenCode.make
  requestStop?: (info: Info, endpoint: Endpoint, timeoutMs: number) => Promise<boolean>
  waitForStop?: (info: Info, endpoint: Endpoint, timeoutMs: number) => Promise<boolean>
  isProcessAlive?: (pid: number) => boolean
  getProcessIdentity?: (pid: number, timeoutMs: number, namespace?: ProcessNamespace) => Promise<ProcessIdentity | undefined>
  probeProcessIdentity?: typeof probeProcessStartIdentity
}

type ProcessOwnerState = "live" | "stale" | "unknown"

export class OpenCodeSharedService {
  private connection?: Promise<ServiceConnection>
  private connected?: ServiceConnection
  private healthCheck?: Promise<ServiceConnection>
  private pendingLaunch?: Promise<ServiceConnection>
  private ensureOptions?: OpenCodeEnsureOptions
  private owned?: OwnedService
  private lease?: LeaseHandle
  private shutdownAttempt?: Promise<void>
  private shutdownRequested = false
  private readonly pendingEvictions = new Map<string, LocationRef>()

  constructor(private readonly dependencies: OpenCodeSharedServiceDependencies = {
    discover: Service.discover,
    stop: Service.stop,
    headers: Service.headers,
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
      location: { directory: location.directory },
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
    if (location.workspaceID && result.workspaceID !== location.workspaceID) {
      throw new Error("OpenCode location workspace does not match the canonical location")
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
    requestOptions?.signal?.throwIfAborted()
    if (ensureOptions) await this.connect(ensureOptions)
    this.pendingEvictions.set(`${location.directory}\0${location.workspaceID ?? ""}`, location)
  }

  shutdown(options: { timeoutMs?: number } = {}): Promise<void> {
    this.shutdownRequested = true
    if (this.shutdownAttempt) return this.shutdownAttempt
    const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000)
    const attempt = this.stopOwnedService(timeoutMs).finally(() => {
      if (this.shutdownAttempt === attempt) this.shutdownAttempt = undefined
    })
    this.shutdownAttempt = attempt
    return attempt
  }

  private async stopOwnedService(timeoutMs: number): Promise<void> {
    const deadlineAt = Date.now() + timeoutMs
    const pendingLaunch = this.pendingLaunch
    if (pendingLaunch) {
      try {
        await this.withDeadline(pendingLaunch, Math.max(1, deadlineAt - Date.now()), "OpenCode service launch reconciliation")
      } catch (error) {
        if (this.pendingLaunch === pendingLaunch) throw error
      }
    }
    const lease = this.lease
    if (!lease) return
    await this.withLifecycleLock(lease, deadlineAt, async () => {
      const ownMetadata = await this.readLease(lease.file)
      if (!ownMetadata || ownMetadata.identity !== lease.identity) {
        if (this.lease === lease) this.lease = undefined
        throw new Error("OpenCode service lease identity changed")
      }
      const leaseDirectory = path.dirname(lease.file)
      const initialPeers = await this.readPeerLeases(leaseDirectory, lease.file)
      const inheritedProof = await this.deadPeerProof(
        initialPeers,
        this.ensureOptions?.file,
        deadlineAt,
        ownMetadata.launchSignature,
      )
      await this.pruneLeaseArtifacts(leaseDirectory, lease.file, lease.staleLockMs, deadlineAt)
      const peers = await this.readPeerLeases(leaseDirectory, lease.file)
      const peerEntries = (await readdir(leaseDirectory))
        .filter((entry) => entry.endsWith(".json") && path.join(leaseDirectory, entry) !== lease.file)
      if (peers.length !== peerEntries.length) {
        throw new Error("An OpenCode service peer lease has invalid identity metadata; retaining lease")
      }
      const leasedProof = ownMetadata.service ?? inheritedProof
      if (leasedProof && leasedProof.registrationFile !== this.ensureOptions?.file) {
        throw new Error("OpenCode service lease proof references an unexpected registration; retaining lease")
      }
      let owned = this.owned
      if (leasedProof) {
        const launchSignature = ownMetadata.launchSignature
        if (!launchSignature || leasedProof.launchSignature !== launchSignature) {
          throw new Error("OpenCode service lease proof has a different launch configuration; retaining lease")
        }
        owned = {
          stopOptions: { file: leasedProof.registrationFile },
          info: leasedProof.info,
          endpoint: leasedProof.endpoint,
          nativePid: leasedProof.nativePid === true,
          processIdentity: leasedProof.processIdentity,
          launchSignature,
        }
        this.owned = owned
      }
      if (!owned) {
        await this.releaseLease(lease)
        return
      }
      if (ownMetadata.state === "stopping") {
        const stopped = await this.waitForOwnedStop(owned, deadlineAt)
        if (!stopped) throw new Error("A previous OpenCode service stop has an uncertain outcome; retaining lease")
        await this.finishOwnedStop(lease, owned)
        return
      }
      const peerStates = await Promise.all(peers.map(async (peer) => ({
        peer,
        state: await this.processOwnerState(peer.metadata, deadlineAt),
      })))
      if (peerStates.some(({ state }) => state === "unknown")) {
        throw new Error("An OpenCode service peer identity could not be verified; retaining lease")
      }
      const livePeers = peerStates.filter(({ state }) => state === "live").map(({ peer }) => peer)
      if (livePeers.length) {
        if (livePeers.some((peer) => peer.metadata.launchSignature !== owned.launchSignature)) {
          throw new Error("OpenCode service peer launch configuration changed; retaining lease")
        }
        if (!livePeers.some((peer) => peer.metadata.service
          && peer.metadata.service.launchSignature === owned.launchSignature
          && this.sameInfo(peer.metadata.service.info, owned.info))) {
          const elected = livePeers.sort((left, right) => left.metadata.identity.localeCompare(right.metadata.identity))[0]
          await this.writeLease(elected.file, {
            ...elected.metadata,
            service: this.serviceProof(owned),
            updatedAt: Date.now(),
          })
        }
        await this.releaseLease(lease)
        if (this.owned && this.sameInfo(this.owned.info, owned.info)) this.owned = undefined
        return
      }
      const current = await readSecureServiceInfo(owned.stopOptions.file)
      // ponytail: uncertain registration or an unsupported stop API leaks the service; no PID is ever signaled.
      if (!current || !this.sameInfo(current, owned.info)) {
        throw new Error("OpenCode service ownership can no longer be proven; retaining lease")
      }
      if (!owned.processIdentity || !this.sameProcessIdentity(
        await this.currentProcessIdentity(owned.info.pid, deadlineAt, owned.processIdentity.namespace),
        owned.processIdentity,
      )) {
        throw new Error("OpenCode service process identity changed; retaining lease")
      }
      // ponytail: eviction is process-local and only safe after proving no peer and the exact daemon identity.
      await this.flushPendingEvictions(owned)
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) throw new Error("OpenCode service shutdown deadline elapsed; retaining lease")
      const proof = this.serviceProof(owned)
      await this.writeLease(lease.file, { ...ownMetadata, service: proof, state: "stopping", updatedAt: Date.now() })
      const stopped = await this.withDeadline(
        this.dependencies.requestStop
          ? this.dependencies.requestStop(owned.info, owned.endpoint, remaining)
          : this.requestStop(owned),
        remaining,
        "OpenCode service stop",
      )
      if (!stopped) {
        await this.writeLease(lease.file, { ...ownMetadata, service: proof, state: "active", updatedAt: Date.now() })
        throw new Error("OpenCode service rejected or failed the stop request; retaining lease")
      }
      if (!await this.waitForOwnedStop(owned, deadlineAt)) {
        throw new Error("OpenCode service accepted stop but did not exit before the shutdown deadline; retaining lease")
      }
      await this.finishOwnedStop(lease, owned)
    })
  }

  private async waitForOwnedStop(
    owned: OwnedService,
    deadlineAt: number,
  ): Promise<boolean> {
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) return false
    return this.withDeadline(
      this.dependencies.waitForStop
        ? this.dependencies.waitForStop(owned.info, owned.endpoint, remaining)
        : this.waitForStop(owned, remaining, deadlineAt),
      remaining,
      "OpenCode service stop completion",
    )
  }

  private async finishOwnedStop(
    lease: LeaseHandle,
    owned: OwnedService,
  ): Promise<void> {
    await this.releaseLease(lease)
    if (this.owned && this.sameInfo(this.owned.info, owned.info)) this.owned = undefined
    this.clear()
  }

  private connect(options?: OpenCodeEnsureOptions): Promise<ServiceConnection> {
    const selectedOptions = options ?? this.ensureOptions ?? {}
    const launchSignature = this.launchSignature(selectedOptions)
    if (!this.connected) {
      if (this.pendingLaunch) {
        if (this.ensureOptions && launchSignature !== this.launchSignature(this.ensureOptions)) {
          return Promise.reject(new Error("OpenCode service launch configuration changed while startup is in progress"))
        }
        return this.withDeadline(this.pendingLaunch, selectedOptions.timeoutMs ?? 30_000, "OpenCode service ensure")
      }
      return this.connection ?? this.startConnection(selectedOptions)
    }
    if (launchSignature !== this.connected.launchSignature) {
      return Promise.reject(new Error("OpenCode service launch configuration does not match the connected daemon"))
    }
    if (this.healthCheck) return this.healthCheck

    const current = this.connection!
    const {
      contenderFile: _contenderFile,
      leaseFile: _leaseFile,
      lockDirectory: _lockDirectory,
      timeoutMs: _timeoutMs,
      staleLockMs: _staleLockMs,
      nativePid: _nativePid,
      wslDistro: _wslDistro,
      environment: _environment,
      launcherRecordsPid: _launcherRecordsPid,
      windowsVerbatimArguments: _windowsVerbatimArguments,
      onStart: _onStart,
      command: _command,
      ...discoverOptions
    } = selectedOptions
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
    if (options.nativePid === false && !options.wslDistro) {
      return Promise.reject(new Error("OpenCode service wrapper cannot prove the service PID"))
    }
    const {
      contenderFile,
      leaseFile,
      lockDirectory,
      timeoutMs = 30_000,
      staleLockMs = DEFAULT_STALE_LOCK_MS,
      environment,
      launcherRecordsPid,
      windowsVerbatimArguments,
      ...ensureOptions
    } = options
    const launchSignature = this.launchSignature(options)
    const onStart = ensureOptions.onStart
    const pending = this.ensureLease(
      leaseFile,
      lockDirectory,
      contenderFile,
      ensureOptions.file,
      timeoutMs,
      staleLockMs,
      launchSignature,
    ).then(() => {
      const launch = (this.dependencies.ensure
        ? this.dependencies.ensure({
          ...ensureOptions,
          onStart: (reason, previousVersion) => onStart?.(reason, previousVersion),
        }).then((endpoint) => ({ endpoint, started: true }))
        : this.ensureSafely(ensureOptions, environment, launcherRecordsPid, windowsVerbatimArguments, timeoutMs)
      ).then(async ({ endpoint, started }) => {
        assertLoopbackServiceUrl(endpoint.url)
        const connection = {
          endpoint,
          stopOptions: { file: ensureOptions.file },
          client: this.dependencies.makeClient({
            baseUrl: endpoint.url,
            headers: this.dependencies.headers(endpoint),
          }),
          launchSignature,
        }
        const info = await this.proveOwnership(connection.stopOptions.file, contenderFile, endpoint, started, timeoutMs)
        if (info) {
          const processIdentity = await this.requireServiceProcessIdentity(info.pid, timeoutMs, this.serviceNamespace())
          this.owned = {
            stopOptions: connection.stopOptions,
            info,
            endpoint,
            nativePid: options.nativePid !== false,
            processIdentity,
            launchSignature,
          }
          await this.updateLeaseService({
            info,
            endpoint,
            registrationFile: connection.stopOptions.file!,
            nativePid: this.owned.nativePid,
            processIdentity,
            launchSignature,
          })
        }
        this.connected = connection
        return connection
      })
      const tracked = launch.finally(() => {
        if (this.pendingLaunch === tracked) this.pendingLaunch = undefined
        if (this.shutdownRequested) setImmediate(() => { void this.reconcileLateLaunch() })
      })
      this.pendingLaunch = tracked
      return this.withDeadline(tracked, timeoutMs, "OpenCode service ensure")
    })
    const connection = pending.catch((error) => {
      this.invalidate(connection)
      throw error
    })
    this.connection = connection
    return connection
  }

  private async reconcileLateLaunch(): Promise<void> {
    await this.shutdownAttempt?.catch(() => undefined)
    const lease = this.lease
    if (!lease) return
    await this.shutdown({ timeoutMs: lease.lifecycleTimeoutMs }).catch(() => undefined)
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

  private async proveOwnership(
    file: string | undefined,
    contenderFile: string | undefined,
    endpoint: Endpoint,
    started: boolean,
    timeoutMs: number,
  ): Promise<Info | undefined> {
    if (!file) return undefined
    const [info, contenders] = await Promise.all([
      readSecureServiceInfo(file),
      contenderFile ? readFile(contenderFile, "utf8").catch(() => "") : "",
    ])
    if (!info || !started) return undefined
    if (info.url !== endpoint.url || info.password !== endpoint.auth?.password) return undefined
    const lease = this.lease && await this.readLease(this.lease.file)
    if (this.dependencies.ensure) {
      if (!contenderFile || !contenders.split(/\r?\n/).includes(String(info.pid))) return undefined
    } else if (!lease?.launch || lease.launch.nativePid !== (this.ensureOptions?.nativePid !== false)) {
      return undefined
    }
    if (!this.dependencies.ensure && !await this.registrationMatchesLaunch(file, endpoint)) return undefined
    if (!await this.requireServiceProcessIdentity(info.pid, timeoutMs, this.serviceNamespace())) return undefined
    return info
  }

  private async ensureSafely(
    options: EnsureOptions,
    environment: NodeJS.ProcessEnv | undefined,
    launcherRecordsPid: boolean | undefined,
    windowsVerbatimArguments: boolean | undefined,
    timeoutMs: number,
  ): Promise<{ endpoint: Endpoint; started: boolean }> {
    const discovered = await this.dependencies.discover(options)
    if (discovered) return {
      endpoint: discovered,
      started: await this.registrationMatchesLaunch(options.file, discovered),
    }
    const lease = this.lease
    if (!lease) throw new Error("OpenCode service launch requires a lifecycle lease")
    const command = options.command
    if (!command?.length) throw new Error("Missing OpenCode service command")
    await this.quarantineStaleRegistration(options.file, lease)
    let launch = await this.prepareLaunchIntent(lease, this.ensureOptions?.nativePid !== false)
    options.onStart?.("missing")
    const child = this.spawnService(command, environment, windowsVerbatimArguments)
    child.stderr?.resume()
    if (!child.pid) throw new Error("OpenCode service process did not expose a PID")
    if (launch.nativePid && lease.contenderFile && !launcherRecordsPid) await appendFile(lease.contenderFile, `${child.pid}\n`)
    launch = { ...launch, servicePid: launch.nativePid && !launcherRecordsPid ? child.pid : undefined }
    await this.updateLaunchIntent(lease, launch)
    const deadlineAt = Date.now() + timeoutMs
    let lastError: Error | undefined
    const childFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", (error) => reject(new Error(`Failed to start OpenCode service: ${error.message}`)))
      child.once("exit", (code, signal) => {
        if (launcherRecordsPid && code === 0) return
        lastError = new Error(`OpenCode service exited before registration (${signal ?? code ?? "unknown"})`)
      })
    })
    child.unref()
    while (Date.now() < deadlineAt) {
      const endpoint = await Promise.race([
        this.dependencies.discover(options),
        childFailure,
      ])
      if (endpoint) return { endpoint, started: true }
      if (lastError) throw lastError
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadlineAt - Date.now()))))
    }
    throw new Error(`OpenCode service ensure timed out after ${timeoutMs}ms`)
  }

  private spawnService(
    command: ReadonlyArray<string>,
    environment: NodeJS.ProcessEnv | undefined,
    windowsVerbatimArguments: boolean | undefined,
  ): ChildProcess {
    const [executable, ...args] = command
    if (!executable) throw new Error("Missing OpenCode service command")
    return spawn(executable, args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: environment,
      windowsHide: true,
      windowsVerbatimArguments,
    })
  }

  private async prepareLaunchIntent(lease: LeaseHandle, nativePid: boolean): Promise<LaunchIntent> {
    const launch = { identity: randomUUID(), createdAt: Date.now(), nativePid, contenderFile: lease.contenderFile }
    await this.updateLaunchIntent(lease, launch)
    return launch
  }

  private async updateLaunchIntent(lease: LeaseHandle, launch: LaunchIntent): Promise<void> {
    await this.withLifecycleLock(lease, Date.now() + lease.lifecycleTimeoutMs, async () => {
      const metadata = await this.readLease(lease.file)
      if (!metadata || metadata.identity !== lease.identity) throw new Error("OpenCode service lease identity changed")
      await this.writeLease(lease.file, { ...metadata, launch, updatedAt: Date.now() })
    })
  }

  private async requireServiceProcessIdentity(
    pid: number,
    timeoutMs: number,
    namespace: ProcessNamespace,
  ): Promise<ProcessIdentity> {
    const identity = await (this.dependencies.getProcessIdentity ?? getProcessStartIdentity)(pid, Math.max(1, timeoutMs), namespace)
    if (!identity) throw new Error("Unable to prove the OpenCode service process identity")
    return identity
  }

  private async registrationMatchesLaunch(file: string | undefined, endpoint: Endpoint): Promise<boolean> {
    const lease = this.lease && await this.readLease(this.lease.file)
    const launch = lease?.launch
    const info = await readSecureServiceInfo(file)
    if (!launch || !info || info.url !== endpoint.url || info.password !== endpoint.auth?.password) return false
    if (launch.servicePid !== undefined) return launch.servicePid === info.pid
    if (launch.contenderFile) {
      const contenders = await readFile(launch.contenderFile, "utf8").catch(() => "")
      if (contenders.split(/\r?\n/).includes(String(info.pid))) return true
    }
    return false
  }

  private async quarantineStaleRegistration(file: string | undefined, lease: LeaseHandle): Promise<void> {
    if (!file) return
    const info = await readSecureServiceInfo(file)
    if (!info) {
      await this.quarantineRegistrationFile(file, lease.identity)
      return
    }
    const metadata = await this.readLease(lease.file)
    const proof = metadata?.service
    const namespace = proof?.processIdentity?.namespace ?? this.serviceNamespace()
    if (namespace.kind === "host" && !this.processIsAlive(info.pid)) {
      await this.quarantineRegistrationFile(file, lease.identity, info)
      return
    }
    if (namespace.kind === "wsl") {
      const probe = await (this.dependencies.probeProcessIdentity ?? probeProcessStartIdentity)(
        info.pid,
        lease.lifecycleTimeoutMs,
        namespace,
      )
      if (probe.status === "missing") {
        await this.quarantineRegistrationFile(file, lease.identity, info)
        return
      }
      if (probe.status === "unknown") {
        throw new Error("OpenCode service registration is unhealthy but its WSL PID identity cannot be verified")
      }
    }
    if (proof && this.sameInfo(proof.info, info) && proof.processIdentity) {
      const currentIdentity = await this.currentProcessIdentity(
        info.pid,
        Date.now() + lease.lifecycleTimeoutMs,
        proof.processIdentity.namespace,
      )
      if (currentIdentity && !this.sameProcessIdentity(currentIdentity, proof.processIdentity)) {
        await this.quarantineRegistrationFile(file, lease.identity, info)
        return
      }
    }
    throw new Error("OpenCode service registration is unhealthy but its PID identity cannot be proven stale")
  }

  private async quarantineRegistrationFile(file: string, identity: string, expected?: Info): Promise<void> {
    if (expected) {
      const current = await readSecureServiceInfo(file)
      if (!current || !this.sameInfo(current, expected)) return
    }
    const quarantine = `${file}.stale-${identity}-${randomUUID()}`
    try {
      await rename(file, quarantine)
      await rm(quarantine, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  private sameInfo(left: Info, right: Info): boolean {
    return left.id === right.id
      && left.version === right.version
      && left.url === right.url
      && left.pid === right.pid
      && left.password === right.password
  }

  private async ensureLease(
    file: string | undefined,
    lockDirectory: string | undefined,
    contenderFile: string | undefined,
    registrationFile: string | undefined,
    timeoutMs: number,
    staleLockMs: number,
    launchSignature: string,
  ): Promise<void> {
    if (!file || !lockDirectory) return
    if (this.lease) {
      const metadata = await this.readLease(this.lease.file)
      if (!metadata || metadata.identity !== this.lease.identity || metadata.launchSignature !== launchSignature) {
        throw new Error("OpenCode service launch configuration does not match the active lifecycle lease")
      }
      return
    }
    const identity = randomUUID()
    const lease = {
      file,
      lockDirectory,
      contenderFile,
      identity,
      staleLockMs: Math.max(1, staleLockMs),
      lifecycleTimeoutMs: timeoutMs,
    }
    const deadlineAt = Date.now() + timeoutMs
    await this.withLifecycleLock(lease, deadlineAt, async () => {
      const peerLeases = await this.readPeerLeases(path.dirname(file))
      const peerStates = await Promise.all(peerLeases.map((peer) => this.processOwnerState(peer.metadata, deadlineAt)))
      if (peerLeases.some((peer, index) => peerStates[index] === "live" && peer.metadata.launchSignature !== launchSignature)) {
        throw new Error("OpenCode service launch configuration does not match the shared daemon")
      }
      if (await this.hasConflictingStaleService(
        peerLeases,
        peerStates,
        registrationFile,
        launchSignature,
        deadlineAt,
      )) {
        throw new Error("OpenCode service launch configuration does not match the discovered daemon")
      }
      const inheritedProof = await this.deadPeerProof(
        peerLeases,
        registrationFile,
        deadlineAt,
        launchSignature,
      )
      const inheritedLaunch = inheritedProof ? undefined : await this.deadPeerLaunch(
        peerLeases,
        deadlineAt,
        launchSignature,
      )
      await this.pruneLeaseArtifacts(path.dirname(file), undefined, lease.staleLockMs, deadlineAt)
      const now = Date.now()
      const processIdentity = await this.requireCurrentProcessIdentity(deadlineAt)
      await this.writeLease(file, {
        version: 1,
        identity,
        pid: process.pid,
        processIdentity,
        createdAt: now,
        updatedAt: now,
        state: "active",
        contenderFile,
        launch: inheritedLaunch,
        service: inheritedProof,
        launchSignature,
      }, true)
      this.lease = lease
    })
  }

  private async updateLeaseService(service: ServiceProof): Promise<void> {
    const lease = this.lease
    if (!lease) return
    await this.withLifecycleLock(lease, Date.now() + lease.lifecycleTimeoutMs, async () => {
      const metadata = await this.readLease(lease.file)
      if (!metadata || metadata.identity !== lease.identity) throw new Error("OpenCode service lease identity changed")
      await this.writeLease(lease.file, { ...metadata, service, updatedAt: Date.now() })
    })
  }

  private async releaseLease(lease: LeaseHandle): Promise<void> {
    const metadata = await this.readLease(lease.file)
    if (metadata?.identity === lease.identity) await rm(lease.file, { force: true })
    if (lease.contenderFile) await rm(lease.contenderFile, { force: true })
    if (this.lease === lease) this.lease = undefined
  }

  private async readPeerLeases(directory: string, ownFile?: string): Promise<Array<{ file: string; metadata: LeaseMetadata }>> {
    const entries = (await readdir(directory)).filter((entry) => entry.endsWith(".json"))
    const peers = await Promise.all(entries.map(async (entry) => {
      const file = path.join(directory, entry)
      if (file === ownFile) return undefined
      const metadata = await this.readLease(file)
      return metadata ? { file, metadata } : undefined
    }))
    return peers.filter((peer): peer is { file: string; metadata: LeaseMetadata } => Boolean(peer))
  }

  private async pruneLeaseArtifacts(
    directory: string,
    ownFile: string | undefined,
    staleMs: number,
    deadlineAt: number,
  ): Promise<void> {
    for (const entry of await readdir(directory)) {
      const file = path.join(directory, entry)
      if (file === ownFile || (!entry.endsWith(".json") && !entry.endsWith(".tmp"))) continue
      const peer = entry.endsWith(".json") ? await this.readLease(file) : undefined
      if (peer) {
        const state = await this.processOwnerState(peer, deadlineAt)
        if (state === "live" || (state === "unknown" && Date.now() - peer.updatedAt < staleMs)) continue
        const current = await this.readLease(file)
        if (!current || current.identity !== peer.identity) continue
        const currentState = await this.processOwnerState(current, deadlineAt)
        if (currentState === "live" || (currentState === "unknown" && Date.now() - current.updatedAt < staleMs)) continue
        await rm(file, { force: true })
        continue
      }
      await this.pruneInvalidArtifact(file, staleMs)
    }
  }

  private async pruneInvalidArtifact(file: string, staleMs: number): Promise<void> {
    try {
      const before = await lstat(file)
      if (!before.isFile() || before.isSymbolicLink() || Date.now() - before.mtimeMs < staleMs) return
      const after = await lstat(file)
      if (!this.sameFileIdentity(before, after) || Date.now() - after.mtimeMs < staleMs) return
      await rm(file, { force: true })
    } catch {}
  }

  private async deadPeerProof(
    peers: Array<{ file: string; metadata: LeaseMetadata }>,
    registrationFile: string | undefined,
    deadlineAt: number,
    launchSignature: string | undefined,
  ): Promise<ServiceProof | undefined> {
    if (!registrationFile || !launchSignature) return undefined
    const states = await Promise.all(peers.map((peer) => this.processOwnerState(peer.metadata, deadlineAt)))
    const proofs = peers
      .filter((peer, index) => states[index] === "stale" && peer.metadata.launchSignature === launchSignature)
      .map((peer) => peer.metadata.service)
      .filter((proof): proof is ServiceProof => (
        proof?.registrationFile === registrationFile && proof.launchSignature === launchSignature
      ))
    const first = proofs[0]
    if (!first) return undefined
    return proofs.every((proof) => this.sameInfo(proof.info, first.info)
      && this.sameEndpoint(proof.endpoint, first.endpoint)
      && proof.nativePid === first.nativePid
      && (proof.processIdentity === undefined
        ? first.processIdentity === undefined
        : first.processIdentity !== undefined && this.sameProcessIdentity(proof.processIdentity, first.processIdentity)))
      ? first
      : undefined
  }

  private async deadPeerLaunch(
    peers: Array<{ file: string; metadata: LeaseMetadata }>,
    deadlineAt: number,
    launchSignature: string,
  ): Promise<LaunchIntent | undefined> {
    for (const peer of peers) {
      if (
        peer.metadata.launchSignature !== launchSignature
        || !peer.metadata.launch
        || await this.processOwnerState(peer.metadata, deadlineAt) !== "stale"
      ) continue
      return peer.metadata.launch
    }
    return undefined
  }

  private async hasConflictingStaleService(
    peers: Array<{ file: string; metadata: LeaseMetadata }>,
    states: ProcessOwnerState[],
    registrationFile: string | undefined,
    launchSignature: string,
    deadlineAt: number,
  ): Promise<boolean> {
    if (!registrationFile) return false
    const current = await readSecureServiceInfo(registrationFile)
    if (!current) return false
    for (let index = 0; index < peers.length; index++) {
      const peer = peers[index]
      const proof = peer?.metadata.service
      if (
        states[index] !== "stale"
        || !proof
        || (peer?.metadata.launchSignature === launchSignature && proof.launchSignature === launchSignature)
        || proof.registrationFile !== registrationFile
        || !this.sameInfo(proof.info, current)
      ) continue
      if (!proof.processIdentity) return true
      if (proof.processIdentity.namespace.kind === "host" && !this.processIsAlive(proof.info.pid)) continue
      if (proof.processIdentity.namespace.kind === "wsl") {
        const timeoutMs = deadlineAt - Date.now()
        if (timeoutMs <= 0) return true
        const probe = await (this.dependencies.probeProcessIdentity ?? probeProcessStartIdentity)(
          proof.info.pid,
          timeoutMs,
          proof.processIdentity.namespace,
        )
        if (probe.status === "missing") continue
        if (probe.status !== "found" || this.sameProcessIdentity(probe.identity, proof.processIdentity)) return true
        continue
      }
      const identity = await this.currentProcessIdentity(
        proof.info.pid,
        deadlineAt,
        proof.processIdentity.namespace,
      )
      if (!identity || this.sameProcessIdentity(identity, proof.processIdentity)) return true
    }
    return false
  }

  private async processOwnerState(
    owner: Pick<LeaseMetadata | LockOwner, "pid" | "processIdentity">,
    deadlineAt: number,
  ): Promise<ProcessOwnerState> {
    const timeoutMs = deadlineAt - Date.now()
    if (timeoutMs <= 0) return "unknown"
    if (owner.processIdentity.namespace.kind === "wsl") {
      const probe = await (this.dependencies.probeProcessIdentity ?? probeProcessStartIdentity)(
        owner.pid,
        timeoutMs,
        owner.processIdentity.namespace,
      )
      if (probe.status === "missing") return "stale"
      return probe.status === "found" && this.sameProcessIdentity(probe.identity, owner.processIdentity) ? "live" : "unknown"
    }
    if (!this.processIsAlive(owner.pid)) return "stale"
    const identity = await (this.dependencies.getProcessIdentity ?? getProcessStartIdentity)(
      owner.pid,
      timeoutMs,
      owner.processIdentity.namespace,
    )
    return identity ? this.sameProcessIdentity(identity, owner.processIdentity) ? "live" : "stale" : "unknown"
  }

  private async requireCurrentProcessIdentity(deadlineAt: number): Promise<ProcessIdentity> {
    const timeoutMs = deadlineAt - Date.now()
    const identity = timeoutMs > 0
      ? await (this.dependencies.getProcessIdentity ?? getProcessStartIdentity)(process.pid, timeoutMs, { kind: "host" })
      : undefined
    if (!identity) throw new Error("Unable to prove the OpenCode service lease process identity")
    return identity
  }

  private async currentProcessIdentity(
    pid: number,
    deadlineAt: number,
    namespace: ProcessNamespace,
  ): Promise<ProcessIdentity | undefined> {
    const timeoutMs = deadlineAt - Date.now()
    return timeoutMs > 0
      ? (this.dependencies.getProcessIdentity ?? getProcessStartIdentity)(pid, timeoutMs, namespace)
      : undefined
  }

  private processIsAlive(pid: number): boolean {
    if (this.dependencies.isProcessAlive) return this.dependencies.isProcessAlive(pid)
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  private async readLease(file: string): Promise<LeaseMetadata | undefined> {
    try {
      const before = await lstat(file)
      if (!before.isFile() || before.isSymbolicLink()) return undefined
      const handle = await open(file, "r")
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || (process.platform !== "win32" && (before.dev !== stat.dev || before.ino !== stat.ino))) return undefined
        const value: unknown = JSON.parse(await handle.readFile("utf8"))
        if (!this.isLeaseMetadata(value)) return undefined
        return value
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }

  private async writeLease(file: string, metadata: LeaseMetadata, exclusive = false): Promise<void> {
    if (exclusive) {
      const handle = await open(file, "wx", 0o600)
      try { await handle.writeFile(JSON.stringify(metadata)) } finally { await handle.close() }
      return
    }
    const temporary = `${file}.${metadata.identity}.tmp`
    const handle = await open(temporary, "wx", 0o600)
    try { await handle.writeFile(JSON.stringify(metadata)) } finally { await handle.close() }
    try { await rename(temporary, file) } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  private isLeaseMetadata(value: unknown): value is LeaseMetadata {
    if (!value || typeof value !== "object") return false
    const lease = value as Partial<LeaseMetadata>
    return lease.version === 1
      && typeof lease.identity === "string" && lease.identity.length > 0
      && typeof lease.pid === "number" && Number.isInteger(lease.pid) && lease.pid > 0
      && this.isProcessIdentity(lease.processIdentity)
      && typeof lease.createdAt === "number" && Number.isFinite(lease.createdAt)
      && typeof lease.updatedAt === "number" && Number.isFinite(lease.updatedAt)
      && (lease.state === "active" || lease.state === "stopping")
      && (lease.contenderFile === undefined || typeof lease.contenderFile === "string")
      && (lease.launch === undefined || this.isLaunchIntent(lease.launch))
      && (lease.service === undefined || this.isServiceProof(lease.service))
      && (lease.launchSignature === undefined || typeof lease.launchSignature === "string")
  }

  private isLaunchIntent(value: unknown): value is LaunchIntent {
    if (!value || typeof value !== "object") return false
    const launch = value as Partial<LaunchIntent>
    return typeof launch.identity === "string" && launch.identity.length > 0
      && typeof launch.createdAt === "number" && Number.isFinite(launch.createdAt)
      && typeof launch.nativePid === "boolean"
      && (launch.contenderFile === undefined || typeof launch.contenderFile === "string")
      && (launch.servicePid === undefined || Number.isInteger(launch.servicePid) && launch.servicePid > 0)
  }

  private isServiceProof(value: unknown): value is ServiceProof {
    if (!value || typeof value !== "object") return false
    const proof = value as Partial<ServiceProof>
    if (typeof proof.registrationFile !== "string") return false
    if (!proof.endpoint || !proof.info || typeof proof.endpoint.url !== "string") return false
    if (!proof.info.id || !Number.isInteger(proof.info.pid) || proof.info.pid <= 0) return false
    if (proof.nativePid !== undefined && typeof proof.nativePid !== "boolean") return false
    if (proof.processIdentity !== undefined && !this.isProcessIdentity(proof.processIdentity)) return false
    if (proof.launchSignature !== undefined && typeof proof.launchSignature !== "string") return false
    if (proof.info.url !== proof.endpoint.url || proof.info.password !== proof.endpoint.auth?.password) return false
    try { assertLoopbackServiceUrl(proof.endpoint.url) } catch { return false }
    return true
  }

  private serviceProof(owned: OwnedService): ServiceProof {
    if (!owned.stopOptions.file) throw new Error("OpenCode service registration file is missing")
    return {
      info: owned.info,
      endpoint: owned.endpoint,
      registrationFile: owned.stopOptions.file,
      nativePid: owned.nativePid,
      processIdentity: owned.processIdentity,
      launchSignature: owned.launchSignature,
    }
  }

  private async withLifecycleLock<T>(lease: Pick<LeaseHandle, "lockDirectory" | "identity" | "staleLockMs">, deadlineAt: number, run: () => Promise<T>): Promise<T> {
    const owner: LockOwner = {
      version: 1,
      identity: lease.identity,
      pid: process.pid,
      processIdentity: await this.requireCurrentProcessIdentity(deadlineAt),
      createdAt: Date.now(),
    }
    const ownerFile = path.join(lease.lockDirectory, LOCK_OWNER_FILE)
    while (true) {
      try {
        await mkdir(lease.lockDirectory, { mode: 0o700 })
        await this.writeLockOwner(ownerFile, owner)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        await this.reclaimStaleLock(lease.lockDirectory, ownerFile, lease.staleLockMs, deadlineAt)
        if (Date.now() >= deadlineAt) throw new Error("Timed out waiting for the OpenCode service lifecycle lock")
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadlineAt - Date.now()))))
      }
    }
    try {
      return await run()
    } finally {
      const current = await this.readLockOwner(ownerFile)
      if (current?.identity === owner.identity) await rm(lease.lockDirectory, { recursive: true, force: true })
    }
  }

  private async reclaimStaleLock(directory: string, ownerFile: string, staleLockMs: number, deadlineAt: number): Promise<void> {
    let before: Stats
    try { before = await lstat(directory) } catch { return }
    if (!before.isDirectory() || before.isSymbolicLink()) return
    const ownerBefore = await this.regularFileStat(ownerFile)
    const owner = await this.readLockOwner(ownerFile)
    if (owner && await this.processOwnerState(owner, deadlineAt) === "live") return
    const now = Date.now()
    const ownerCreatedAt = owner && owner.createdAt <= now ? owner.createdAt : 0
    if (now - Math.max(before.mtimeMs, ownerBefore?.mtimeMs ?? 0, ownerCreatedAt) < staleLockMs) return
    const current = await this.readLockOwner(ownerFile)
    if (owner) {
      if (!current || current.identity !== owner.identity || await this.processOwnerState(current, deadlineAt) === "live") return
    } else if (current) return
    let after: Stats
    try { after = await lstat(directory) } catch { return }
    const ownerAfter = await this.regularFileStat(ownerFile)
    if (!this.sameFileIdentity(before, after)) return
    if (ownerBefore && (!ownerAfter || !this.sameFileIdentity(ownerBefore, ownerAfter))) return
    if (!ownerBefore && ownerAfter) return
    if (Date.now() - Math.max(after.mtimeMs, ownerAfter?.mtimeMs ?? 0) < staleLockMs) return
    const staleDirectory = `${directory}.stale-${owner?.identity ?? "unknown"}-${randomUUID()}`
    try { await rename(directory, staleDirectory) } catch { return }
    await rm(staleDirectory, { recursive: true, force: true })
  }

  private sameFileIdentity(left: Stats, right: Stats): boolean {
    return left.dev === right.dev
      && left.ino === right.ino
      && left.size === right.size
      && left.mtimeMs === right.mtimeMs
      && left.ctimeMs === right.ctimeMs
      && left.birthtimeMs === right.birthtimeMs
  }

  private async regularFileStat(file: string): Promise<Stats | undefined> {
    try {
      const stat = await lstat(file)
      return stat.isFile() && !stat.isSymbolicLink() ? stat : undefined
    } catch {
      return undefined
    }
  }

  private async writeLockOwner(file: string, owner: LockOwner): Promise<void> {
    const handle = await open(file, "wx", 0o600)
    try { await handle.writeFile(JSON.stringify(owner)) } finally { await handle.close() }
  }

  private async readLockOwner(file: string): Promise<LockOwner | undefined> {
    try {
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined
      const handle = await open(file, "r")
      try {
        const value: unknown = JSON.parse(await handle.readFile("utf8"))
        if (!value || typeof value !== "object") return undefined
        const owner = value as Partial<LockOwner>
        if (owner.version !== 1 || typeof owner.identity !== "string" || !owner.identity) return undefined
        if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) return undefined
        if (!this.isProcessIdentity(owner.processIdentity)) return undefined
        if (typeof owner.createdAt !== "number" || !Number.isFinite(owner.createdAt)) return undefined
        return owner as LockOwner
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }

  private async withDeadline<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private requestStop = async (owned: OwnedService): Promise<boolean> => {
    await (this.dependencies.stop ?? Service.stop)(owned.stopOptions)
    return true
  }

  private waitForStop = async (
    owned: OwnedService,
    timeoutMs: number,
    deadlineAt: number,
  ): Promise<boolean> => {
    while (true) {
      if (owned.processIdentity) {
        if (owned.processIdentity.namespace.kind === "host" && !this.processIsAlive(owned.info.pid)) return true
        if (owned.processIdentity.namespace.kind === "wsl") {
          const remaining = deadlineAt - Date.now()
          if (remaining <= 0) return false
          const probe = await (this.dependencies.probeProcessIdentity ?? probeProcessStartIdentity)(
            owned.info.pid,
            remaining,
            owned.processIdentity.namespace,
          )
          if (probe.status === "missing") return true
          if (probe.status === "found" && !this.sameProcessIdentity(probe.identity, owned.processIdentity)) return true
        } else {
          const identity = await this.currentProcessIdentity(owned.info.pid, deadlineAt, owned.processIdentity.namespace)
          if (identity && !this.sameProcessIdentity(identity, owned.processIdentity)) return true
        }
      }
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) return false
      const health = await fetch(new URL("/api/health", owned.info.url), {
        headers: this.dependencies.headers(owned.endpoint),
        signal: AbortSignal.timeout(Math.min(250, remaining)),
      }).then(async (response) => {
        const body = await response.json() as { healthy?: unknown; pid?: unknown }
        return { unavailable: false, pid: response.ok && body?.healthy === true && Number.isInteger(body.pid) ? body.pid as number : undefined }
      }).catch(() => ({ unavailable: true, pid: undefined }))
      if (health.pid !== undefined && health.pid !== owned.info.pid) return true
      if (health.unavailable && await this.registrationDisappeared(owned.stopOptions.file)) return true
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadlineAt - Date.now()))))
    }
  }

  private async registrationDisappeared(file: string | undefined): Promise<boolean> {
    if (!file) return false
    try {
      await lstat(file)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
    }
    return false
  }

  private serviceNamespace(): ProcessNamespace {
    return this.ensureOptions?.wslDistro
      ? { kind: "wsl", distro: this.ensureOptions.wslDistro }
      : { kind: "host" }
  }

  private isProcessIdentity(value: unknown): value is ProcessIdentity {
    if (!value || typeof value !== "object") return false
    const identity = value as Partial<ProcessIdentity>
    const namespace = identity.namespace as Partial<ProcessNamespace> | undefined
    return Number.isInteger(identity.pid) && (identity.pid ?? 0) > 0
      && typeof identity.start === "string" && identity.start.length > 0
      && (namespace?.kind === "host"
        || namespace?.kind === "wsl" && typeof namespace.distro === "string" && namespace.distro.length > 0)
  }

  private sameProcessIdentity(left: ProcessIdentity | undefined, right: ProcessIdentity): boolean {
    if (!left) return false
    return left.pid === right.pid
      && left.start === right.start
      && left.namespace.kind === right.namespace.kind
      && (left.namespace.kind !== "wsl"
        || right.namespace.kind === "wsl" && left.namespace.distro.toLowerCase() === right.namespace.distro.toLowerCase())
  }

  private launchSignature(options: OpenCodeEnsureOptions): string {
    const environment = Object.entries(options.environment ?? {}).sort(([left], [right]) => left.localeCompare(right))
    return createHash("sha256").update(JSON.stringify({
      command: options.command ?? [],
      environment,
      version: options.version ?? null,
      wslDistro: options.wslDistro ?? null,
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
    })).digest("hex")
  }

  private async flushPendingEvictions(owned: OwnedService): Promise<void> {
    if (!this.pendingEvictions.size) return
    const client = this.connected?.client ?? this.dependencies.makeClient({
      baseUrl: owned.endpoint.url,
      headers: this.dependencies.headers(owned.endpoint),
    })
    for (const location of this.pendingEvictions.values()) {
      await client.debug.location.evict({
        location: { directory: location.directory, workspace: location.workspaceID },
      })
    }
    this.pendingEvictions.clear()
  }
}
