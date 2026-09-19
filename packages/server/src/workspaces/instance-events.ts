import { isSessionNotFoundError, type LocationRef, type OpenCodeEvent } from "@opencode/client"
import { readLocationRef } from "../opencode/compatibility/location"
import { EventBus } from "../events/bus"
import { Logger } from "../logger"
import { WorkspaceManager } from "./manager"
import { InstanceStreamStatus } from "../api-types"
import { InstanceEventQueue } from "./instance-event-queue"

const RECONNECT_DELAY_MS = 1000
const LOCATION_OWNER_CACHE_MS = 2000
const SESSION_LOCATION_CACHE_MS = 2000
const GLOBAL_EVENT_TYPES = new Set([
  "catalog.updated",
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
  current: () => boolean
  signal: AbortSignal
  queue: InstanceEventQueue
  key: string
  bytes: number
  recipients: Array<{ id: string; epoch: number }>
  receivedAt: number
}

export class InstanceEventBridge {
  private readonly controller = new AbortController()
  private status: InstanceStreamStatus = "connecting"
  private generation = 0
  private task?: Promise<void>
  private readonly locationOwners = new Map<string, { expiresAt: number; owns: Promise<boolean> }>()
  private ownershipRevision = 0
  private lastSlowWarning = -Infinity
  private readonly workspaceEpochs = new Map<string, number>()
  private readonly sessionLocations = new Map<string, { expiresAt: number; location: Promise<LocationRef | undefined> }>()
  private readonly ptyLocations = new Map<string, LocationRef>()
  private readonly shellLocations = new Map<string, LocationRef>()
  private readonly onWorkspaceStarted = (event: { workspace: { id: string } }) => {
    this.advanceWorkspace(event.workspace.id)
    this.clearLocationCaches()
    if (!this.task) this.task = this.run()
    else this.publishStatus(event.workspace.id, this.status)
  }
  private readonly onWorkspaceStopped = (event: { workspaceId: string }) => {
    this.advanceWorkspace(event.workspaceId)
    this.clearLocationCaches()
    this.publishStatus(event.workspaceId, "disconnected", "workspace stopped")
  }
  private readonly onWorkspaceError = (event: { workspace: { id: string } }) => {
    this.advanceWorkspace(event.workspace.id)
    this.clearLocationCaches()
    this.publishStatus(event.workspace.id, "disconnected", "workspace error")
  }
  private readonly onWorktreesChanged = () => this.invalidateOwners()

  constructor(private readonly options: InstanceEventBridgeOptions) {
    const bus = this.options.eventBus
    bus.on("workspace.started", this.onWorkspaceStarted)
    bus.on("workspace.stopped", this.onWorkspaceStopped)
    bus.on("workspace.error", this.onWorkspaceError)
    bus.on("workspace.worktreesChanged", this.onWorktreesChanged)
  }

  shutdown() {
    this.controller.abort()
    const bus = this.options.eventBus
    bus.off("workspace.started", this.onWorkspaceStarted)
    bus.off("workspace.stopped", this.onWorkspaceStopped)
    bus.off("workspace.error", this.onWorkspaceError)
    bus.off("workspace.worktreesChanged", this.onWorktreesChanged)
    for (const workspace of this.options.workspaceManager.list()) {
      this.publishStatus(workspace.id, "disconnected")
    }
  }

  private async run() {
    while (!this.controller.signal.aborted) {
      this.generation += 1
      this.clearLocationCaches()
      this.updateStatus("connecting")
      const attempt = new AbortController()
      let failure: Error | undefined
      const queue = new InstanceEventQueue(error => { failure = error; attempt.abort() })
      const abort = () => { attempt.abort(); queue.close() }
      this.controller.signal.addEventListener("abort", abort, { once: true })
      const current = () => !attempt.signal.aborted && !this.controller.signal.aborted
      try {
        const events = await this.options.workspaceManager.subscribeToSharedService(attempt.signal)
        let confirmed = false
        for await (const event of events) {
          if (!current()) break
          if (!confirmed) {
            if (event.type !== "server.connected") {
              throw new Error(`Shared OpenCode event stream started with ${event.type}, expected server.connected`)
            }
            confirmed = true
            this.updateStatus("connected")
          }
          if (event.type === "worktree.updated") {
            this.options.workspaceManager.invalidateWorktrees()
            this.invalidateOwners()
          }
          const receivedAt = Date.now()
          const bytes = Buffer.byteLength(JSON.stringify(event))
          const key = this.eventKey(event)
          const recipients = this.options.workspaceManager.list().map(workspace => ({
            id: workspace.id, epoch: this.workspaceEpochs.get(workspace.id) ?? 0,
          }))
          queue.enqueue(`resolve:${key}`, bytes, () => this.publishEvent(event, {
            current, signal: attempt.signal, queue, key, bytes, recipients, receivedAt,
          }))
        }
        if (!this.controller.signal.aborted) throw failure ?? new Error("Shared OpenCode event stream ended")
      } catch (error) {
        attempt.abort()
        queue.close()
        if (this.controller.signal.aborted) return
        const reason = failure ?? error
        this.options.logger.warn({ err: reason }, "Shared OpenCode event stream disconnected")
        this.updateStatus("error", reason instanceof Error ? reason.message : String(reason))
        await this.delay(RECONNECT_DELAY_MS)
      } finally {
        attempt.abort()
        queue.close()
        this.controller.signal.removeEventListener("abort", abort)
      }
    }
  }

  private async publishEvent(event: OpenCodeEvent, route: EventRoute) {
    if (!route.current()) return
    const sessionId = this.sessionId(event)
    const ptyId = this.ptyId(event)
    const shellId = this.shellId(event)
    if (event.type === "session.moved" && sessionId) this.sessionLocations.delete(sessionId)

    // A scoped event is native location authority, not merely a cwd hint. Keep
    // that full pair for subsequent locationless PTY/Shell/session events.
    const location = event.location ? readLocationRef(event.location)
      : (ptyId ? this.ptyLocations.get(ptyId) : undefined)
        ?? this.ptyInfoLocation(event)
        ?? (shellId ? this.shellLocations.get(shellId) : undefined)
        ?? this.shellInfoLocation(event)
        ?? (sessionId ? await this.resolveSessionLocation(sessionId, route.signal) : undefined)
    if (!route.current()) return
    if (!location) {
      if (GLOBAL_EVENT_TYPES.has(event.type)) {
        this.deliverEvent(event, undefined, route)
        return
      }
      if (event.type === "session.deleted" && sessionId) {
        // Deletion can make session.get return 404 before the event arrives. Session IDs are
        // service-global, so notifying every logical workspace cannot delete another session.
        this.deliverEvent(event, undefined, route)
        this.sessionLocations.delete(sessionId)
      }
      return
    }
    // The moved envelope can refer to the old location. The next locationless
    // event must resolve the native session rather than cache that old owner.
    if (sessionId && event.type !== "session.moved") {
      this.sessionLocations.set(sessionId, {
        expiresAt: Date.now() + SESSION_LOCATION_CACHE_MS,
        location: Promise.resolve(location),
      })
    }
    if (ptyId) this.ptyLocations.set(ptyId, location)
    if (shellId) this.shellLocations.set(shellId, location)

    this.deliverEvent(event, location, route)
    if (event.type === "session.deleted" && sessionId) this.sessionLocations.delete(sessionId)
    if (event.type === "pty.deleted" && ptyId) this.ptyLocations.delete(ptyId)
    if (event.type === "shell.deleted" && shellId) this.shellLocations.delete(shellId)
  }

  private eventKey(event: OpenCodeEvent): string {
    const session = this.sessionId(event)
    if (session) return `session:${session}`
    const pty = this.ptyId(event)
    if (pty) return `pty:${pty}`
    const shell = this.shellId(event)
    if (shell) return `shell:${shell}`
    const location = event.location ? readLocationRef(event.location) : undefined
    return `location:${JSON.stringify([location?.directory, location?.workspaceID])}`
  }

  private deliverEvent(event: OpenCodeEvent, location: LocationRef | undefined, route: EventRoute): void {
    const resolvedAt = Date.now()
    for (const { id: instanceId, epoch } of route.recipients) {
      const current = () => route.current() && (this.workspaceEpochs.get(instanceId) ?? 0) === epoch
      route.queue.enqueue(`deliver:${JSON.stringify([instanceId, route.key])}`, route.bytes, async () => {
        if (!current()) return
        const lookupStarted = Date.now()
        let allowed = !location
        let revision: number
        do {
          revision = this.ownershipRevision
          if (location) allowed = await this.resolveLocationOwner(instanceId, location, current)
          if (!current()) return
        } while (revision !== this.ownershipRevision)
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
        if (allowed) this.options.eventBus.publish({ type: "instance.event", instanceId, event })
      })
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

  private resolveSessionLocation(sessionId: string, signal: AbortSignal): Promise<LocationRef | undefined> {
    const now = Date.now()
    const cached = this.sessionLocations.get(sessionId)
    if (cached && cached.expiresAt > now) return cached.location

    const resolve = () => this.options.workspaceManager.getSharedServiceClient()
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
    this.sessionLocations.set(sessionId, entry)
    const settle = () => { entry.expiresAt = Date.now() + SESSION_LOCATION_CACHE_MS }
    void location.then(settle, settle)
    return location
  }

  private resolveLocationOwner(instanceId: string, location: LocationRef, current: () => boolean): Promise<boolean> {
    const now = Date.now()
    const key = JSON.stringify([instanceId, location.directory, location.workspaceID])
    const cached = this.locationOwners.get(key)
    if (cached && cached.expiresAt > now) return cached.owns

    const resolve = () => location.workspaceID === undefined
      ? this.options.workspaceManager.ownsDirectory(instanceId, location.directory)
      : this.options.workspaceManager.ownsLocation(instanceId, location)
    const owns = Promise.resolve().then(resolve).catch(() => current() ? resolve() : false)
      .catch(error => {
        if (current()) this.options.logger.warn({ err: error, instanceId, location }, "Failed to resolve instance event location owner")
        return false
      })
    const entry = { expiresAt: Number.POSITIVE_INFINITY, owns }
    this.locationOwners.set(key, entry)
    const settle = () => { entry.expiresAt = Date.now() + LOCATION_OWNER_CACHE_MS }
    void owns.then(settle, settle)
    return owns
  }

  private invalidateOwners(): void {
    this.ownershipRevision++
    this.locationOwners.clear()
  }

  private advanceWorkspace(id: string): void {
    this.workspaceEpochs.set(id, (this.workspaceEpochs.get(id) ?? 0) + 1)
  }

  private clearLocationCaches(): void {
    this.invalidateOwners()
    this.sessionLocations.clear()
    this.ptyLocations.clear()
    this.shellLocations.clear()
  }

  private updateStatus(status: InstanceStreamStatus, reason?: string) {
    this.status = status
    for (const workspace of this.options.workspaceManager.list()) {
      this.publishStatus(workspace.id, status, reason)
    }
  }

  private publishStatus(instanceId: string, status: InstanceStreamStatus, reason?: string) {
    this.options.logger.debug({ instanceId, status, reason }, "Instance event status updated")
    this.options.eventBus.publish({ type: "instance.eventStatus", instanceId, status, generation: this.generation, reason })
  }

  private delay(duration: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timeout)
        this.controller.signal.removeEventListener("abort", done)
        resolve()
      }
      const timeout = setTimeout(done, duration)
      this.controller.signal.addEventListener("abort", done, { once: true })
    })
  }
}
