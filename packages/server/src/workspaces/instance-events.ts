import { randomBytes } from "node:crypto"
import { isSessionNotFoundError, type LocationRef, type OpenCodeEvent } from "@opencode/client"
import { readLocationRef } from "../opencode/compatibility/location"
import { runtimeIdentity } from "../opencode/compatibility/runtime"
import { EventBus } from "../events/bus"
import { Logger } from "../logger"
import { WorkspaceManager } from "./manager"
import { nativeEventConnections, type ServiceConnection } from "./opencode-service"
import { integrationEventForRelay } from "../opencode/integrations/events"
import { InstanceStreamStatus, type InstanceEventSource as Source, type InstanceEventGap } from "../api-types"
import { InstanceEventQueue, InstanceEventBudget, InstanceEventQueueError, type InstanceEventReservation } from "./instance-event-queue"

const RECONNECT_DELAY_MS = 1000
const LOCATION_OWNER_CACHE_MS = 2000
const SESSION_LOCATION_CACHE_MS = 2000
const ROUTING_RESYNC_MIN_MS = 5000
const ROUTING_RESYNC_MAX_MS = 60_000
const GLOBAL_EVENT_TYPES = new Set([
  "agent.updated",
  "command.updated",
  "config.updated",
  "credential.switched",
  "credential.updated",
  "integration.updated",
  "installation.update-available",
  "installation.updated",
  "mcp.resources.changed",
  "mcp.status.changed",
  "models-dev.refreshed",
  "model.updated",
  "plugin.updated",
  "provider.updated",
  "reference.updated",
  "server.connected",
  "skill.updated",
  "websearch.updated",
  "worktree.updated",
])

interface InstanceEventBridgeOptions {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
}

interface EventRoute {
  source: Source
  connection?: ServiceConnection
  reservation: InstanceEventReservation
  current: () => boolean
  signal: AbortSignal
  queue: InstanceEventQueue
  key: string
  bytes: number
  recipients: Array<{ id: string; epoch: number; liveGeneration: number }>
  receivedAt: number
}

/** Opaque per-source identity, issued randomly and held by the relay. The
 * token covers the same fields connection validation compares (url, runtime
 * version/pid, auth) — the tuple itself never leaves the process. Subscribers
 * see only the token: it is stable across same-source reconnects, rotates on
 * replacement, and nothing a client could recompute or correlate across
 * backends derives from it. */
function daemonSourceKey(connection: ServiceConnection): string {
  const identity = runtimeIdentity(connection.endpoint)
  return JSON.stringify([
    connection.endpoint.url,
    identity?.version ?? null,
    identity?.pid ?? null,
    connection.endpoint.auth?.username ?? null,
    connection.endpoint.auth?.password ?? null,
  ])
}

export class InstanceEventBridge {
  private readonly sources = new Map<string, InstanceEventRelay>()
  private readonly budget = new InstanceEventBudget()
  private generation = 0
  private liveGeneration = 0
  private readonly unobserve?: () => void

  constructor(private readonly options: InstanceEventBridgeOptions) {
    this.sources.set("local-shared", this.create("local-shared"))
    this.unobserve = options.workspaceManager.observeAdmittedEventSources?.((ids, credentialsChanged) => {
      this.budget.explicitSources = ids.length
      for (const [id, relay] of this.sources) {
        if (id !== "local-shared" && !ids.includes(id)) { relay.shutdown(); this.sources.delete(id) }
      }
      for (const id of ids) {
        if (!this.sources.has(id)) {
          const relay = this.create(id)
          this.sources.set(id, relay)
          relay.start()
        }
      }
      if (credentialsChanged) this.sources.get(credentialsChanged)?.restart()
    })
  }

  private create(serverId: string): InstanceEventRelay {
    return new InstanceEventRelay({ ...this.options, serverId, budget: this.budget,
      nextGeneration: () => ++this.generation,
      nextLiveGeneration: () => ++this.liveGeneration,
    })
  }

  shutdown(): void {
    this.unobserve?.()
    for (const source of this.sources.values()) source.shutdown()
    this.sources.clear()
  }
}

function nextEvent(iterator: AsyncIterator<OpenCodeEvent>, signal: AbortSignal): Promise<IteratorResult<OpenCodeEvent>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", cancel)
    const cancel = () => { cleanup(); resolve({ done: true, value: undefined }) }
    if (signal.aborted) { cancel(); return }
    signal.addEventListener("abort", cancel, { once: true })
    void iterator.next().then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

class InstanceEventRelay {
  private readonly controller = new AbortController()
  private status: InstanceStreamStatus = "connecting"
  private generation = 0
  private connectionGeneration?: number
  private readonly liveStatuses = new Map<string, { status: InstanceStreamStatus; source: Source; reason?: string; gap?: InstanceEventGap; generation: number }>()
  private task?: Promise<void>
  private marker?: { event: OpenCodeEvent; source: Source }
  private attempt?: AbortController
  private retryWake?: AbortController
  private restartRequested = false
  /** The attributed source of the current shared stream and its opaque token.
   * Exactly one entry: a reconnect of the same source keeps its token, a
   * replacement drops the superseded source's credential-bearing key with it,
   * and relay disposal releases both. */
  private daemonSource?: { key: string; token: string }
  private readonly locationOwners = new Map<string, { expiresAt: number; owns: Promise<boolean> }>()
  private ownershipRevision = 0
  private lastSlowWarning = -Infinity
  private readonly workspaceEpochs = new Map<string, number>()
  private workspaceEpoch = 0
  private readonly sessionLocations = new Map<string, { expiresAt: number; location: Promise<LocationRef | undefined> }>()
  private readonly ptyLocations = new Map<string, { expiresAt: number; location: LocationRef }>()
  private readonly shellLocations = new Map<string, { expiresAt: number; location: LocationRef }>()
  private readonly formLocations = new Map<string, { expiresAt: number; location: LocationRef }>()
  private readonly routingResyncs = new Map<string, { next: number; interval: number; timer?: ReturnType<typeof setTimeout> }>()
  private readonly onWorkspaceStarted = (event: { workspace: { id: string } }) => {
    if (!this.recipients().some(workspace => workspace.id === event.workspace.id)) return
    this.advanceWorkspace(event.workspace.id)
    this.clearLocationCaches()
    if (!this.task) this.task = this.run()
    else {
      this.publishStatus(event.workspace.id, this.status)
      if (this.marker && this.status === "connected") this.options.eventBus.publish({
        type: "instance.event", instanceId: event.workspace.id, event: this.marker.event, source: this.marker.source,
        liveGeneration: this.liveStatuses.get(event.workspace.id)!.generation,
      })
    }
  }
  private readonly onWorkspaceStopped = (event: { workspaceId: string }) => {
    if (!this.workspaceEpochs.has(event.workspaceId)) return
    this.advanceWorkspace(event.workspaceId)
    this.clearLocationCaches()
    this.clearRoutingResync(event.workspaceId)
    this.publishStatus(event.workspaceId, "disconnected", "workspace stopped")
    this.workspaceEpochs.delete(event.workspaceId)
    this.liveStatuses.delete(event.workspaceId)
  }
  private readonly onWorkspaceError = (event: { workspace: { id: string } }) => {
    if (!this.workspaceEpochs.has(event.workspace.id)) return
    this.advanceWorkspace(event.workspace.id)
    this.clearLocationCaches()
    this.clearRoutingResync(event.workspace.id)
    this.publishStatus(event.workspace.id, "disconnected", "workspace error")
    this.workspaceEpochs.delete(event.workspace.id)
    this.liveStatuses.delete(event.workspace.id)
  }
  private readonly onWorktreesChanged = (event: { workspaceId: string }) => {
    if (this.recipients().some(workspace => workspace.id === event.workspaceId)) this.invalidateOwners()
  }

  constructor(private readonly options: InstanceEventBridgeOptions & {
    serverId: string; budget: InstanceEventBudget; nextGeneration: () => number; nextLiveGeneration: () => number
  }) {
    const bus = this.options.eventBus
    bus.on("workspace.started", this.onWorkspaceStarted)
    bus.on("workspace.stopped", this.onWorkspaceStopped)
    bus.on("workspace.error", this.onWorkspaceError)
    bus.on("workspace.worktreesChanged", this.onWorktreesChanged)
  }

  start(): void { if (!this.task) this.task = this.run() }

  restart(): void {
    this.restartRequested = true
    this.marker = undefined
    this.status = "error"
    this.attempt?.abort()
    this.retryWake?.abort()
  }

  private source(): Source { return { serverId: this.options.serverId, generation: this.generation,
    ...(this.connectionGeneration === undefined ? {} : { connectionGeneration: this.connectionGeneration }) } }

  private recipients() {
    const workspaces = this.options.workspaceManager.list().filter(workspace => (workspace.binding?.serverId ?? "local-shared") === this.options.serverId)
    for (const workspace of workspaces) if (!this.workspaceEpochs.has(workspace.id)) this.advanceWorkspace(workspace.id)
    return workspaces
  }

  shutdown() {
    this.controller.abort()
    this.clearLocationCaches()
    this.marker = undefined
    this.workspaceEpochs.clear()
    this.clearRoutingResync()
    // Release the current source's credential-bearing key and its token.
    this.daemonSource = undefined
    const bus = this.options.eventBus
    bus.off("workspace.started", this.onWorkspaceStarted)
    bus.off("workspace.stopped", this.onWorkspaceStopped)
    bus.off("workspace.error", this.onWorkspaceError)
    bus.off("workspace.worktreesChanged", this.onWorktreesChanged)
    for (const workspace of this.recipients()) {
      this.publishStatus(workspace.id, "disconnected", undefined, "revoked")
    }
    this.liveStatuses.clear()
  }

  private async run() {
    let retry = RECONNECT_DELAY_MS
    while (!this.controller.signal.aborted) {
      this.restartRequested = false
      this.generation = this.options.nextGeneration()
      this.connectionGeneration = undefined
      this.marker = undefined
      this.clearLocationCaches()
      // Reconnecting reconciles every instance, including pending routing pulses.
      this.clearRoutingResync()
      this.updateStatus("connecting")
      const attempt = new AbortController()
      this.attempt = attempt
      let failure: Error | undefined
      let ended = false
      const queue = new InstanceEventQueue(error => {
        failure = error
        this.marker = undefined
        this.status = "error"
        attempt.abort()
      }, undefined, this.options.budget, this.options.serverId !== "local-shared",
      () => this.updateStatus("error", "event backlog draining after share activation", "overflow"))
      const abort = () => { attempt.abort(); queue.close(); this.marker = undefined; this.status = "error" }
      this.controller.signal.addEventListener("abort", abort, { once: true })
      const current = () => !attempt.signal.aborted && !this.controller.signal.aborted
      let connection: ServiceConnection | undefined
      let iterator: AsyncIterator<OpenCodeEvent> | undefined
      let unbind = () => {}
      try {
        let events: AsyncIterable<OpenCodeEvent>
        if (this.options.serverId === "local-shared") events = await this.options.workspaceManager.subscribeToSharedService(attempt.signal)
        else {
          const acquired = await this.options.workspaceManager.getServerConnections().acquireForServer(this.options.serverId)
          const generation = "generation" in acquired ? acquired.generation : undefined
          if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) throw new Error("Explicit event connection generation unavailable")
          this.connectionGeneration = generation
          connection = acquired
          connection.assertCurrent()
          const signal = (connection as { signal?: AbortSignal }).signal
          signal?.addEventListener("abort", abort, { once: true })
          unbind = () => signal?.removeEventListener("abort", abort)
          if (signal?.aborted || !current()) throw new Error("Event source revoked")
          events = connection.client.event.subscribe({ signal: attempt.signal })
        }
        const source = this.source()
        iterator = events[Symbol.asyncIterator]()
        let confirmed = false
        let ingested = 0
        while (current()) {
          const result = await nextEvent(iterator, attempt.signal)
          if (result.done) { ended = true; break }
          let event = integrationEventForRelay(result.value)
          if (!event) continue
          if (!current()) break
          const captured = connection ?? nativeEventConnections.get(result.value)
          captured?.assertCurrent()
          if (captured) nativeEventConnections.set(event, captured)
          if (!confirmed) {
            if (event.type !== "server.connected") {
              throw new Error(`Shared OpenCode event stream started with ${event.type}, expected server.connected`)
            }
            confirmed = true
            retry = RECONNECT_DELAY_MS
            this.updateStatus("connected")
          }
          if (event.type === "worktree.updated") {
            if (this.options.serverId === "local-shared") this.options.workspaceManager.invalidateWorktrees()
            this.invalidateOwners()
          }
          const receivedAt = Date.now()
          if (event.type === "server.connected" && captured) {
            // Decorate before admission so resolution and deliveries pay the final envelope.
            const key = this.options.serverId === "local-shared" ? daemonSourceKey(captured) : String(source.generation)
            if (this.daemonSource?.key !== key) this.daemonSource = { key, token: randomBytes(16).toString("hex") }
            event = { ...event, data: { ...event.data, daemon: this.daemonSource.token } } as OpenCodeEvent
            nativeEventConnections.set(event, captured)
          }
          const bytes = Buffer.byteLength(JSON.stringify(event))
          const key = this.eventKey(event)
          const recipients = this.recipients().map(workspace => {
            if (!this.liveStatuses.has(workspace.id)) this.publishStatus(workspace.id, this.status)
            return { id: workspace.id, epoch: this.workspaceEpochs.get(workspace.id) ?? 0,
              liveGeneration: this.liveStatuses.get(workspace.id)!.generation }
          })
          const deliveries = new Map(recipients.map(({ id, liveGeneration }) => [id,
            Buffer.byteLength(JSON.stringify({ type: "instance.event", instanceId: id, event, source, liveGeneration })),
          ]))
          queue.enqueue(`resolve:${key}`, bytes, reservation => this.publishEvent(event, {
            current: () => {
              if (!current()) return false
              try { captured?.assertCurrent(); return true } catch { return false }
            }, source, connection: captured, reservation, signal: attempt.signal, queue, key, bytes, recipients, receivedAt,
          }), receivedAt, deliveries)
          if (++ingested % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve))
        }
        if (!this.controller.signal.aborted) throw failure ?? new Error("Shared OpenCode event stream ended")
      } catch (error) {
        this.marker = undefined
        const revoked = attempt.signal.aborted
        attempt.abort()
        queue.close()
        if (this.controller.signal.aborted) return
        const reason = failure ?? error
        this.options.logger.warn(this.options.serverId === "local-shared" ? { err: reason } : { serverId: this.options.serverId }, "OpenCode event stream disconnected")
        if (connection && !revoked && !failure) connection.invalidate()
        const gap = failure instanceof InstanceEventQueueError ? failure.gap : revoked ? "revoked" : ended ? "eof" : "transport"
        this.updateStatus("error", "native event stream interrupted", gap)
        if (!this.restartRequested) await this.delay(Math.min(30_000, Math.round(retry * (0.8 + Math.random() * 0.4))))
        retry = Math.min(30_000, retry * 2)
      } finally {
        attempt.abort()
        queue.close()
        unbind()
        if (this.attempt === attempt) this.attempt = undefined
        void iterator?.return?.().catch(() => {})
        this.controller.signal.removeEventListener("abort", abort)
      }
    }
  }

  private async publishEvent(event: OpenCodeEvent, route: EventRoute) {
    if (!route.current()) return
    if (event.type === "server.connected") {
      this.marker = { event, source: route.source }
    }
    const sessionId = this.sessionId(event)
    const ptyId = this.ptyId(event)
    const shellId = this.shellId(event)
    const formId = this.formId(event)
    if (event.type === "session.moved" && sessionId) this.sessionLocations.delete(sessionId)

    // A scoped event is native location authority, not merely a cwd hint. Keep
    // that full pair for subsequent locationless PTY/Shell/session events.
    const location = event.location ? readLocationRef(event.location)
      : (ptyId ? this.cachedEntityLocation(this.ptyLocations, ptyId) : undefined)
        ?? this.ptyInfoLocation(event)
        ?? (shellId ? this.cachedEntityLocation(this.shellLocations, shellId) : undefined)
        ?? this.shellInfoLocation(event)
        ?? (formId ? this.cachedEntityLocation(this.formLocations, formId) : undefined)
        ?? (sessionId ? await this.resolveSessionLocation(sessionId, route) : undefined)
    if (!route.current()) return
    if (!location) {
      if (GLOBAL_EVENT_TYPES.has(event.type)) {
        this.deliverEvent(event, undefined, route)
        return
      }
      for (const { id, epoch } of route.recipients) {
        if ((this.workspaceEpochs.get(id) ?? 0) === epoch) this.requestRoutingResync(id)
      }
      return
    }
    // The moved envelope can refer to the old location. The next locationless
    // event must resolve the native session rather than cache that old owner.
    if (sessionId && event.type !== "session.moved") {
      this.setBounded(this.sessionLocations, sessionId, {
        expiresAt: Date.now() + SESSION_LOCATION_CACHE_MS,
        location: Promise.resolve(location),
      })
    }
    if (ptyId) this.setBounded(this.ptyLocations, ptyId, { expiresAt: Date.now() + 60_000, location })
    if (shellId) this.setBounded(this.shellLocations, shellId, { expiresAt: Date.now() + 60_000, location })
    if (formId) this.setBounded(this.formLocations, formId, { expiresAt: Date.now() + 60_000, location })

    this.deliverEvent(event, location, route)
    if (event.type === "session.deleted" && sessionId) this.sessionLocations.delete(sessionId)
    if (event.type === "pty.deleted" && ptyId) this.ptyLocations.delete(ptyId)
    if (event.type === "shell.deleted" && shellId) this.shellLocations.delete(shellId)
    if ((event.type === "form.cancelled" || event.type === "form.replied") && formId) this.formLocations.delete(formId)
  }

  private eventKey(event: OpenCodeEvent): string {
    const session = this.sessionId(event)
    if (session) return `session:${session}`
    const pty = this.ptyId(event)
    if (pty) return `pty:${pty}`
    const shell = this.shellId(event)
    if (shell) return `shell:${shell}`
    const form = this.formId(event)
    if (form) return `form:${form}`
    const location = event.location ? readLocationRef(event.location) : undefined
    return `location:${JSON.stringify([location?.directory, location?.workspaceID])}`
  }

  private deliverEvent(event: OpenCodeEvent, location: LocationRef | undefined, route: EventRoute): void {
    const resolvedAt = Date.now()
    for (const { id: instanceId, epoch, liveGeneration } of route.recipients) {
      const current = () => route.current() && (this.workspaceEpochs.get(instanceId) ?? 0) === epoch
      route.queue.enqueueDelivery(`deliver:${JSON.stringify([instanceId, route.key])}`, route.reservation, instanceId, async () => {
        if (!current()) return
        const lookupStarted = Date.now()
        let allowed = !location
        let revision: number
        try {
          do {
            revision = this.ownershipRevision
            if (location) allowed = await this.resolveLocationOwner(instanceId, location, current, route.signal, route.connection)
            if (!current()) return
          } while (revision !== this.ownershipRevision)
        } catch {
          // The event may belong to this recipient: make it reconcile instead of losing it silently.
          if (current()) this.requestRoutingResync(instanceId)
          return
        }
        // Stopped recipients and work from an earlier connection never publish.
        if (!this.options.workspaceManager.list().some(workspace => workspace.id === instanceId)) return
        const now = Date.now()
        const upstreamAgeMs = "created" in event && typeof event.created === "number" ? route.receivedAt - event.created : undefined
        if ((now - route.receivedAt >= 1000 || (upstreamAgeMs ?? 0) >= 1000) && now - this.lastSlowWarning >= 10_000) {
          this.lastSlowWarning = now
          this.options.logger.warn({ instanceId, eventType: event.type, pending: route.queue.pending,
            routingMs: now - route.receivedAt, ownershipMs: now - lookupStarted,
            locationMs: resolvedAt - route.receivedAt, recipientQueueMs: lookupStarted - resolvedAt,
            upstreamAgeMs,
          }, "Slow instance event routing")
        }
        if (allowed) this.options.eventBus.publish({ type: "instance.event", instanceId, event, source: route.source, liveGeneration })
      }, route.receivedAt)
    }
  }

  private sessionId(event: OpenCodeEvent): string | undefined {
    const data = event.data as { sessionID?: unknown; form?: { sessionID?: unknown } }
    const sessionId = data.sessionID ?? (event.type === "form.created" ? data.form?.sessionID : undefined)
    return typeof sessionId === "string" && sessionId && sessionId !== "global" ? sessionId : undefined
  }

  private ptyId(event: OpenCodeEvent): string | undefined {
    if (!event.type.startsWith("pty.")) return undefined
    const data = event.data as { id?: unknown; info?: { id?: unknown } }
    const id = data.id ?? data.info?.id
    return typeof id === "string" && id ? id : undefined
  }

  private ptyInfoLocation(event: OpenCodeEvent): LocationRef | undefined {
    if (event.type !== "pty.created" && event.type !== "pty.updated") return undefined
    const cwd = (event.data as { info?: { cwd?: unknown } }).info?.cwd
    return typeof cwd === "string" && cwd ? { directory: cwd } : undefined
  }

  private shellId(event: OpenCodeEvent): string | undefined {
    if (!event.type.startsWith("shell.")) return undefined
    const data = event.data as { id?: unknown; info?: { id?: unknown } }
    const id = data.id ?? data.info?.id
    return typeof id === "string" && id ? id : undefined
  }

  private shellInfoLocation(event: OpenCodeEvent): LocationRef | undefined {
    if (event.type !== "shell.created") return undefined
    const cwd = (event.data as { info?: { cwd?: unknown } }).info?.cwd
    return typeof cwd === "string" && cwd ? { directory: cwd } : undefined
  }

  private resolveSessionLocation(sessionId: string, route: EventRoute): Promise<LocationRef | undefined> {
    const signal = route.signal
    const now = Date.now()
    const cached = this.sessionLocations.get(sessionId)
    if (cached && cached.expiresAt > now) return cached.location

    const resolve = () => (route.connection ? Promise.resolve(route.connection.client) : this.options.workspaceManager.getSharedServiceClient())
      .then(client => { if (!route.current()) throw new Error("Event source revoked"); return client })
      .then((client) => client.session.get({ sessionID: sessionId }, { signal }))
      .then((session) => readLocationRef(session.location))
    const location = resolve().catch((error) => {
      if (signal.aborted || isSessionNotFoundError(error)) return undefined
      return resolve().catch((retryError) => {
        if (!signal.aborted) this.options.logger.warn({ err: retryError, sessionId }, "Failed to resolve instance event session location")
        return undefined
      })
    })
    const entry = { expiresAt: Number.POSITIVE_INFINITY, location }
    this.setBounded(this.sessionLocations, sessionId, entry)
    const settle = () => { entry.expiresAt = Date.now() + SESSION_LOCATION_CACHE_MS }
    void location.then(settle, settle)
    return location
  }

  private resolveLocationOwner(instanceId: string, location: LocationRef, current: () => boolean, signal: AbortSignal, connection?: ServiceConnection): Promise<boolean> {
    const now = Date.now()
    const key = JSON.stringify([instanceId, location.directory, location.workspaceID])
    const cached = this.locationOwners.get(key)
    if (cached && cached.expiresAt > now) return cached.owns

    const resolve = () => this.options.serverId === "local-shared" && location.workspaceID === undefined
      ? this.options.workspaceManager.ownsDirectory(instanceId, location.directory, "event")
      : this.options.workspaceManager.ownsLocation(instanceId, location, connection?.client, signal, "event")
    const owns = Promise.resolve().then(resolve).catch(() => current() ? resolve() : false)
    const entry = { expiresAt: Number.POSITIVE_INFINITY, owns }
    this.setBounded(this.locationOwners, key, entry)
    void owns.then(() => { entry.expiresAt = Date.now() + LOCATION_OWNER_CACHE_MS }, error => {
      // Never cache a failure: the next event for this location looks it up again.
      if (this.locationOwners.get(key) === entry) this.locationOwners.delete(key)
      if (current()) this.options.logger.warn({ err: error, instanceId, location }, "Failed to resolve instance event location owner")
    })
    return owns
  }

  /** Pulses one instance's status (error, then connected) so its clients run their
   * reconnect reconciliation for an event that could not be routed. Leading and
   * trailing; the interval doubles while failures persist and resets after a quiet one. */
  private requestRoutingResync(instanceId: string): void {
    const state = this.routingResyncs.get(instanceId)
    if (state?.timer) return
    const now = Date.now()
    if (!state || now >= state.next) {
      this.pulseRoutingResync(instanceId, ROUTING_RESYNC_MIN_MS)
      return
    }
    state.timer = setTimeout(() => this.pulseRoutingResync(instanceId, Math.min(state.interval * 2, ROUTING_RESYNC_MAX_MS)), state.next - now)
    state.timer.unref?.()
  }

  private pulseRoutingResync(instanceId: string, interval: number): void {
    this.routingResyncs.set(instanceId, { next: Date.now() + interval, interval })
    if (this.status !== "connected" || !this.options.workspaceManager.list().some(workspace => workspace.id === instanceId)) return
    this.publishStatus(instanceId, "error", "event routing failed", "ownership")
    this.publishStatus(instanceId, "connected")
  }

  private clearRoutingResync(instanceId?: string): void {
    for (const [id, state] of this.routingResyncs) {
      if (instanceId !== undefined && id !== instanceId) continue
      clearTimeout(state.timer)
      this.routingResyncs.delete(id)
    }
  }

  private invalidateOwners(): void {
    this.ownershipRevision++
    this.locationOwners.clear()
  }

  private advanceWorkspace(id: string): void {
    this.workspaceEpochs.set(id, ++this.workspaceEpoch)
  }

  private formId(event: OpenCodeEvent): string | undefined {
    if (!event.type.startsWith("form.")) return undefined
    const data = event.data as { id?: unknown; form?: { id?: unknown } }
    const id = data.id ?? data.form?.id
    return typeof id === "string" && id ? id : undefined
  }

  private setBounded<T>(map: Map<string, T>, key: string, value: T): void {
    if (!map.has(key) && map.size >= 1024) map.delete(map.keys().next().value!)
    map.set(key, value)
  }

  private cachedEntityLocation(map: Map<string, { expiresAt: number; location: LocationRef }>, id: string): LocationRef | undefined {
    const cached = map.get(id)
    if (cached && cached.expiresAt > Date.now()) return cached.location
    map.delete(id)
    return undefined
  }

  private clearLocationCaches(): void {
    this.invalidateOwners()
    this.sessionLocations.clear()
    this.ptyLocations.clear()
    this.shellLocations.clear()
    this.formLocations.clear()
  }

  private updateStatus(status: InstanceStreamStatus, reason?: string, gap?: InstanceEventGap) {
    this.status = status
    for (const workspace of this.recipients()) {
      this.publishStatus(workspace.id, status, reason, gap)
    }
  }

  private publishStatus(instanceId: string, status: InstanceStreamStatus, reason?: string, gap?: InstanceEventGap) {
    const source = this.source(), previous = this.liveStatuses.get(instanceId)
    const generation = previous?.status === status && previous.source.generation === source.generation
      && previous.source.connectionGeneration === source.connectionGeneration && previous.reason === reason && previous.gap === gap
      ? previous.generation : this.options.nextLiveGeneration()
    this.liveStatuses.set(instanceId, { status, source, reason, gap, generation })
    this.options.logger.debug({ instanceId, status, reason }, "Instance event status updated")
    this.options.eventBus.publish({ type: "instance.eventStatus", instanceId, status, generation: this.generation, reason, source, gap, liveGeneration: generation })
  }

  private delay(duration: number) {
    if (this.controller.signal.aborted) return Promise.resolve()
    const wake = new AbortController()
    this.retryWake = wake
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timeout)
        this.controller.signal.removeEventListener("abort", done)
        wake.signal.removeEventListener("abort", done)
        if (this.retryWake === wake) this.retryWake = undefined
        resolve()
      }
      const timeout = setTimeout(done, duration)
      this.controller.signal.addEventListener("abort", done, { once: true })
      wake.signal.addEventListener("abort", done, { once: true })
    })
  }
}
