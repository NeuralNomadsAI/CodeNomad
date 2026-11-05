import { OpenCode } from "@opencode/client"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { createRuntimeTransport } from "../compatibility/transport"
import type { OpenCodeServerCredentials } from "./credentials"
import type { OpenCodeServerRegistry } from "./registry"
import { createExplicitTransport } from "./transport"
import { LOCAL_SHARED_SERVER_ID, SERVER_CONNECTION_LIMITS, type ProjectExecutionBinding } from "./types"
import { parseProbeCandidate, probeExplicitCandidate, ServerProbeError, type ProbeCandidate, type ServerProbeResult } from "./probe"
import type { ResolveAddresses } from "./endpoint"
import { waitForAdmission } from "../../server/request-admission"
import { randomUUID } from "node:crypto"
import type { ServerAttachmentReservation, ServerAttachmentReservations } from "./attachment-types"

type Failure = "unknown_server" | "needs_credentials" | "invalid_credentials" | "auth" | "quota" | "disconnected" | "closed" | "stale_connection" | "probe_busy"
export class ServerConnectionError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "ServerConnectionError" }
}
export interface ServerConnection extends ServiceConnection {
  serverId: string
  generation: number
  signal: AbortSignal
}
type Slot = {
  origin: string; admitted: boolean
  controller?: AbortController; pending?: Promise<ServerConnection>; connection?: ServerConnection
}
export interface ServerProjectLease {
  acquire(): Promise<ServiceConnection>
  published(instanceId: string): void
  release(): void
}
type AdmissionObserver = (serverIds: readonly string[], credentialsChanged?: string) => void

/** Backend-wide owner. Local lifecycle is delegated; explicit traffic only uses the protected dialer. */
export class OpenCodeServerConnections {
  #slots = new Map<string, Slot>()
  #projects = new Map<string, Set<symbol>>()
  #disconnected = new Set<string>()
  #generation = 0
  #closed = false
  #probe?: { serverId?: string; origin?: string; controller: AbortController }
  #unsubscribers: (() => void)[]
  #admissionObservers = new Set<AdmissionObserver>()
  #attachmentReceipt = randomUUID()
  #attachmentReservations = new Map<symbol, ServerAttachmentReservation>()

  constructor(private readonly options: {
    registry: OpenCodeServerRegistry
    credentials: OpenCodeServerCredentials
    local: { acquire(): Promise<ServiceConnection>; existing(): ServiceConnection | undefined; invalidate(): void }
    resolveAddresses?: ResolveAddresses
  }) {
    this.#unsubscribers = [
      options.credentials.onChange(id => {
        if (id === undefined) {
          for (const key of this.#slots.keys()) { this.invalidateServer(key); this.publishAdmission(key) }
        } else { this.invalidateServer(id); this.publishAdmission(id) }
        if (id === undefined || this.#probe?.serverId === id) this.#probe?.controller.abort()
      }),
      options.registry.beforeChange(next => {
        this.attachmentsChanged()
        for (const [id, slot] of this.#slots) {
          const profile = next.find(value => value.id === id)
          if (profile?.kind !== "explicit" || profile.origin !== slot.origin) this.disconnect(id)
        }
        if (this.#probe?.serverId) {
          const profile = next.find(value => value.id === this.#probe!.serverId)
          if (profile?.kind !== "explicit" || profile.origin !== this.#probe.origin) this.#probe.controller.abort()
        }
      }),
    ]
  }

  get activeExplicitTargets(): number { return this.#slots.size }

  /** Reservations include occurrences held before workspace publication and disconnected leases. */
  attachmentReservations(serverId: string): ServerAttachmentReservations {
    const reservations = [...this.#attachmentReservations.values()].filter(value => value.serverId === serverId)
    return {
      receipt: this.#attachmentReceipt,
      status: this.#closed || reservations.length > 512 ? "unknown" : "complete",
      reservations: reservations.slice(0, 512).map(value => ({ ...value })),
      inFlight: Boolean(this.#slots.get(serverId)?.pending) || reservations.some(value => value.state === "reserved"),
    }
  }

  attachmentReceiptCurrent(receipt: string): boolean {
    return !this.#closed && receipt === this.#attachmentReceipt
  }

  private attachmentsChanged(): void { this.#attachmentReceipt = randomUUID() }

  /** Snapshot only: no admission, discovery, profile negotiation or lifecycle effects. */
  administrativeState(serverId: string, origin?: string): "connected" | "connecting" | "admitted_offline" | "disconnected" | "unknown" {
    if (this.#closed) return "unknown"
    if (serverId === LOCAL_SHARED_SERVER_ID) return this.options.local.existing() ? "connected" : "unknown"
    const profile = this.options.registry.get(serverId)
    if (profile?.kind !== "explicit" || (origin !== undefined && profile.origin !== origin)) return "unknown"
    const slot = this.#slots.get(serverId)
    if (slot && slot.origin !== profile.origin) return "unknown"
    if (slot?.connection && !slot.connection.signal.aborted) return "connected"
    if (slot?.pending && !slot.controller?.signal.aborted) return "connecting"
    if (slot?.admitted) return "admitted_offline"
    if (this.#disconnected.has(serverId)) return "disconnected"
    return "unknown"
  }

  /** Register before the synchronous snapshot, so admission cannot fall between them. */
  observeAdmitted(observer: AdmissionObserver): () => void {
    this.#admissionObservers.add(observer)
    observer(this.admitted())
    return () => { this.#admissionObservers.delete(observer) }
  }

  private admitted(): string[] {
    return [...this.#slots].filter(([, slot]) => slot.admitted).map(([id]) => id)
  }

  private publishAdmission(credentialsChanged?: string): void {
    const ids = this.admitted()
    for (const observer of this.#admissionObservers) observer(ids, credentialsChanged)
  }

  /** Connect is an explicit in-memory pin. Reading an already disconnected tab cannot call it implicitly. */
  connect(serverId: string): Promise<ServiceConnection> {
    this.#disconnected.delete(serverId)
    return this.acquireForServer(serverId, "connect")
  }

  acquireForWorkspace(binding: ProjectExecutionBinding): Promise<ServiceConnection> {
    return this.acquireForServer(binding.serverId, "read")
  }

  /** Project occurrence leases span windows; each release is idempotent. */
  retainProject(binding: ProjectExecutionBinding): ServerProjectLease {
    this.assertOpen()
    this.profile(binding.serverId)
    const id = binding.serverId, token = Symbol()
    const projects = this.#projects.get(id) ?? new Set<symbol>()
    projects.add(token)
    this.#projects.set(id, projects)
    this.#attachmentReservations.set(token, { reservationId: randomUUID(), serverId: id, directory: binding.directory, state: "reserved" })
    this.attachmentsChanged()
    let released = false
    return {
      acquire: () => released ? Promise.reject(new ServerConnectionError("disconnected")) : this.acquireForServer(id, "project"),
      published: instanceId => {
        const reservation = this.#attachmentReservations.get(token)
        if (released || !reservation || reservation.instanceId === instanceId) return
        this.#attachmentReservations.set(token, { ...reservation, instanceId, state: "published" })
        this.attachmentsChanged()
      },
      release: () => {
        if (released) return
        released = true
        this.#attachmentReservations.delete(token)
        this.attachmentsChanged()
        projects.delete(token)
        if (!projects.size) {
          this.#projects.delete(id)
          this.releaseSlot(id)
        }
      },
    }
  }

  /** Reservation is synchronous, before the first await; only fresh project intent or Connect may admit. */
  acquireForServer(serverId: string, intent: "read" | "project" | "connect" = "read"): Promise<ServiceConnection> {
    try {
      this.assertOpen()
      if (serverId === LOCAL_SHARED_SERVER_ID) return this.options.local.acquire()
      const profile = this.profile(serverId)
      if (profile.kind !== "explicit") throw new ServerConnectionError("unknown_server")
      if (this.#disconnected.has(serverId)) throw new ServerConnectionError("disconnected")
      let slot = this.#slots.get(serverId)
      if (slot && slot.origin !== profile.origin) { this.disconnect(serverId); throw new ServerConnectionError("disconnected") }
      if (!slot) {
        if (intent === "read") throw new ServerConnectionError("disconnected")
        if (this.#slots.size >= SERVER_CONNECTION_LIMITS.explicitActiveTargets) throw new ServerConnectionError("quota")
        slot = { origin: profile.origin, admitted: false }
        this.#slots.set(serverId, slot)
        this.attachmentsChanged()
      }
      if (slot.connection) return Promise.resolve(slot.connection)
      if (slot.pending) return slot.pending
      const current = slot, controller = new AbortController(), generation = ++this.#generation
      this.attachmentsChanged()
      current.controller = controller
      const assertCurrent = () => {
        if (this.#closed || controller.signal.aborted || this.#slots.get(serverId) !== current || current.controller !== controller) {
          throw new ServerConnectionError("stale_connection")
        }
        const metadata = this.options.registry.get(serverId)
        if (metadata?.kind !== "explicit" || metadata.origin !== current.origin) {
          this.disconnect(serverId)
          throw new ServerConnectionError("stale_connection")
        }
      }
      const pending = this.create(serverId, current.origin, generation, controller.signal, assertCurrent).then(connection => {
        assertCurrent()
        current.admitted = true
        current.connection = connection
        this.attachmentsChanged()
        this.publishAdmission()
        return connection
      }).catch(error => {
        if (this.#slots.get(serverId) === current && current.controller === controller) {
          controller.abort()
          if (!current.admitted) this.#slots.delete(serverId)
          this.attachmentsChanged()
        }
        throw error
      }).finally(() => { if (current.pending === pending) { current.pending = undefined; this.attachmentsChanged() } })
      current.pending = pending
      return pending
    } catch (error) { return Promise.reject(error) }
  }

  existingForServer(serverId: string): ServiceConnection | undefined {
    if (serverId === LOCAL_SHARED_SERVER_ID) return this.options.local.existing()
    const connection = this.#slots.get(serverId)?.connection
    connection?.assertCurrent()
    return connection
  }

  /** Offline and credential rotation keep an admitted slot, but revoke every captured wrapper. */
  invalidateServer(serverId: string): void {
    this.attachmentsChanged()
    if (serverId === LOCAL_SHARED_SERVER_ID) { this.options.local.invalidate(); return }
    const slot = this.#slots.get(serverId)
    if (!slot) return
    slot.controller?.abort()
    slot.controller = undefined
    slot.connection = undefined
    slot.pending = undefined
    if (!slot.admitted) this.#slots.delete(serverId)
  }

  disconnect(serverId: string): void {
    this.attachmentsChanged()
    if (serverId === LOCAL_SHARED_SERVER_ID) { this.options.local.invalidate(); return }
    if (this.#probe?.serverId === serverId) this.#probe.controller.abort()
    this.#disconnected.add(serverId)
    this.releaseSlot(serverId)
  }

  /** Single read-only bounded lane, separate from active reservations and event subscriptions. */
  probe(serverId: string, signal?: AbortSignal): Promise<ServerProbeResult> {
    return this.runProbe(async () => {
      const profile = this.profile(serverId)
      if (profile.kind !== "explicit") throw new ServerConnectionError("unknown_server")
      if (this.#probe) this.#probe.origin = profile.origin
      const value = await this.options.credentials.readForConnection(serverId)
      if (value === null) throw new ServerProbeError("needs_credentials", "credentials")
      try { return parseProbeCandidate({ origin: profile.origin, credentials: JSON.parse(value) }) }
      catch { throw new ServerProbeError("invalid_credentials", "credentials") }
    }, signal, serverId)
  }

  probeCandidate(candidate: ProbeCandidate, signal?: AbortSignal): Promise<ServerProbeResult> {
    return this.runProbe(async () => parseProbeCandidate(candidate), signal)
  }

  private async runProbe(candidate: () => Promise<ProbeCandidate>, signal?: AbortSignal, serverId?: string): Promise<ServerProbeResult> {
    this.assertOpen()
    if (this.#probe) throw new ServerConnectionError("probe_busy")
    const controller = new AbortController()
    this.#probe = { serverId, controller }
    const deadline = performance.now() + SERVER_CONNECTION_LIMITS.probeTimeoutMs
    const timer = setTimeout(() => controller.abort(new ServerProbeError("timeout", "operation")), SERVER_CONNECTION_LIMITS.probeTimeoutMs)
    const lifetime = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
    const current = () => {
      lifetime.throwIfAborted()
      if (performance.now() >= deadline) throw new ServerProbeError("timeout", "operation")
      this.assertOpen()
    }
    try {
      return await waitForAdmission((async () => {
        current()
        const value = await candidate()
        current()
        const result = await probeExplicitCandidate(value, lifetime, current, this.options.resolveAddresses)
        current()
        return result
      })(), lifetime)
    } finally { clearTimeout(timer); controller.abort(); if (this.#probe?.controller === controller) this.#probe = undefined }
  }

  async dispose(): Promise<void> {
    this.#closed = true
    this.attachmentsChanged()
    this.#probe?.controller.abort()
    for (const id of this.#slots.keys()) this.releaseSlot(id)
    this.#admissionObservers.clear()
    this.#projects.clear()
    this.#attachmentReservations.clear()
    this.#disconnected.clear()
    for (const unsubscribe of this.#unsubscribers) unsubscribe()
    await this.options.credentials.dispose()
  }

  private async create(serverId: string, origin: string, generation: number, signal: AbortSignal, assertCurrent: () => void): Promise<ServerConnection> {
    const value = await this.options.credentials.readForConnection(serverId)
    assertCurrent()
    if (value === null) throw new ServerConnectionError("needs_credentials")
    let credentials: { username: string; password: string }
    try {
      credentials = JSON.parse(value)
      if (!credentials || typeof credentials.username !== "string" || typeof credentials.password !== "string" || credentials.username.includes(":")) throw new Error()
    } catch { throw new ServerConnectionError("invalid_credentials") }
    const protectedTransport = createExplicitTransport({ origin, credentials, signal })
    const endpoint = { url: origin }
    const dispatch: typeof fetch = async (input, init) => {
      assertCurrent()
      const response = await protectedTransport.fetch(input, init)
      try {
        assertCurrent()
        if (response.status === 401) void this.options.credentials.rejected(serverId) // prototype-1236: re-pair
        if (response.status === 401 || response.status === 403) throw new ServerConnectionError("auth")
        return response
      }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error }
    }
    const transport = createRuntimeTransport(endpoint, dispatch, signal, "explicit-e1")
    const fetch: typeof globalThis.fetch = async (input, init) => { assertCurrent(); return transport.fetch(input, init) }
    const connection: ServerConnection = {
      serverId, generation, signal, endpoint, fetch, assertCurrent,
      invalidate: () => { if (!signal.aborted) this.invalidateServer(serverId) },
      profile: async localSignal => { assertCurrent(); const result = await transport.profile(localSignal); assertCurrent(); return result },
      client: OpenCode.make({ baseUrl: origin, fetch }),
    }
    await connection.profile()
    return connection
  }

  private profile(id: string) {
    const profile = this.options.registry.get(id)
    if (!profile) throw new ServerConnectionError("unknown_server")
    return profile
  }
  private assertOpen(): void { if (this.#closed) throw new ServerConnectionError("closed") }
  private releaseSlot(id: string): void {
    this.attachmentsChanged()
    this.#slots.get(id)?.controller?.abort()
    this.#slots.delete(id)
    this.publishAdmission()
  }
}
