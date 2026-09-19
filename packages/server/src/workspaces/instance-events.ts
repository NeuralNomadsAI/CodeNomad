import { isSessionNotFoundError, type LocationRef, type OpenCodeEvent } from "@opencode/client"
import { readLocationRef } from "../opencode/compatibility/location"
import { EventBus } from "../events/bus"
import { Logger } from "../logger"
import { WorkspaceManager } from "./manager"
import { InstanceStreamStatus } from "../api-types"

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

export class InstanceEventBridge {
  private readonly controller = new AbortController()
  private status: InstanceStreamStatus = "connecting"
  private generation = 0
  private task?: Promise<void>
  private readonly locationOwners = new Map<string, { expiresAt: number; owners: Promise<string[]> }>()
  private readonly sessionLocations = new Map<string, { expiresAt: number; location: Promise<LocationRef | undefined> }>()
  private readonly ptyLocations = new Map<string, LocationRef>()
  private readonly shellLocations = new Map<string, LocationRef>()
  private readonly onWorkspaceStarted = (event: { workspace: { id: string } }) => {
    this.clearLocationCaches()
    if (!this.task) this.task = this.run()
    else this.publishStatus(event.workspace.id, this.status)
  }
  private readonly onWorkspaceStopped = (event: { workspaceId: string }) => {
    this.clearLocationCaches()
    this.publishStatus(event.workspaceId, "disconnected", "workspace stopped")
  }
  private readonly onWorkspaceError = (event: { workspace: { id: string } }) => {
    this.clearLocationCaches()
    this.publishStatus(event.workspace.id, "disconnected", "workspace error")
  }

  constructor(private readonly options: InstanceEventBridgeOptions) {
    const bus = this.options.eventBus
    bus.on("workspace.started", this.onWorkspaceStarted)
    bus.on("workspace.stopped", this.onWorkspaceStopped)
    bus.on("workspace.error", this.onWorkspaceError)
  }

  shutdown() {
    this.controller.abort()
    const bus = this.options.eventBus
    bus.off("workspace.started", this.onWorkspaceStarted)
    bus.off("workspace.stopped", this.onWorkspaceStopped)
    bus.off("workspace.error", this.onWorkspaceError)
    for (const workspace of this.options.workspaceManager.list()) {
      this.publishStatus(workspace.id, "disconnected")
    }
  }

  private async run() {
    while (!this.controller.signal.aborted) {
      this.generation += 1
      this.clearLocationCaches()
      this.updateStatus("connecting")
      try {
        const events = await this.options.workspaceManager.subscribeToSharedService(this.controller.signal)
        let confirmed = false
        for await (const event of events) {
          if (this.controller.signal.aborted) return
          if (!confirmed) {
            if (event.type !== "server.connected") {
              throw new Error(`Shared OpenCode event stream started with ${event.type}, expected server.connected`)
            }
            confirmed = true
            this.updateStatus("connected")
          }
          await this.publishEvent(event)
        }
        if (!this.controller.signal.aborted) throw new Error("Shared OpenCode event stream ended")
      } catch (error) {
        if (this.controller.signal.aborted) return
        this.options.logger.warn({ err: error }, "Shared OpenCode event stream disconnected")
        this.updateStatus("error", error instanceof Error ? error.message : String(error))
        await this.delay(RECONNECT_DELAY_MS)
      }
    }
  }

  private async publishEvent(event: OpenCodeEvent) {
    if (event.type === "worktree.updated") {
      this.options.workspaceManager.invalidateWorktrees()
      this.locationOwners.clear()
    }
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
        ?? (sessionId ? await this.resolveSessionLocation(sessionId) : undefined)
    if (!location) {
      if (GLOBAL_EVENT_TYPES.has(event.type)) {
        this.broadcastEvent(event)
        return
      }
      if (event.type === "session.deleted" && sessionId) {
        // Deletion can make session.get return 404 before the event arrives. Session IDs are
        // service-global, so notifying every logical workspace cannot delete another session.
        this.broadcastEvent(event)
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

    const instanceIds = await this.resolveLocationOwners(location)
    if (instanceIds.length === 0) {
      if (event.type === "session.deleted" && sessionId) this.sessionLocations.delete(sessionId)
      if (event.type === "pty.deleted" && ptyId) this.ptyLocations.delete(ptyId)
      if (event.type === "shell.deleted" && shellId) this.shellLocations.delete(shellId)
      return
    }

    for (const instanceId of instanceIds) {
      this.options.eventBus.publish({ type: "instance.event", instanceId, event })
    }
    if (event.type === "session.deleted" && sessionId) this.sessionLocations.delete(sessionId)
    if (event.type === "pty.deleted" && ptyId) this.ptyLocations.delete(ptyId)
    if (event.type === "shell.deleted" && shellId) this.shellLocations.delete(shellId)
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

  private broadcastEvent(event: OpenCodeEvent): void {
    for (const workspace of this.options.workspaceManager.list()) {
      this.options.eventBus.publish({ type: "instance.event", instanceId: workspace.id, event })
    }
  }

  private resolveSessionLocation(sessionId: string): Promise<LocationRef | undefined> {
    const now = Date.now()
    const cached = this.sessionLocations.get(sessionId)
    if (cached && cached.expiresAt > now) return cached.location

    const resolve = () => this.options.workspaceManager.getSharedServiceClient()
      .then((client) => client.session.get({ sessionID: sessionId }))
      .then((session) => readLocationRef(session.location))
    const location = resolve().catch((error) => {
      if (isSessionNotFoundError(error)) return undefined
      return resolve().catch((retryError) => {
        this.options.logger.warn({ err: retryError, sessionId }, "Failed to resolve instance event session location")
        return undefined
      })
    })
    const entry = { expiresAt: Number.POSITIVE_INFINITY, location }
    this.sessionLocations.set(sessionId, entry)
    const settle = () => { entry.expiresAt = Date.now() + SESSION_LOCATION_CACHE_MS }
    void location.then(settle, settle)
    return location
  }

  private resolveLocationOwners(location: LocationRef): Promise<string[]> {
    const now = Date.now()
    const key = JSON.stringify([location.directory, location.workspaceID])
    const cached = this.locationOwners.get(key)
    if (cached && cached.expiresAt > now) return cached.owners

    const workspaces = this.options.workspaceManager.list()
    const owns = (id: string) => location.workspaceID === undefined
      ? this.options.workspaceManager.ownsDirectory(id, location.directory)
      : this.options.workspaceManager.ownsLocation(id, location)
    const owners = Promise.allSettled(workspaces.map((workspace) => (
      owns(workspace.id)
    )))
      .then(async (ownership) => {
        if (ownership.some((result) => result.status === "rejected")) {
          ownership = await Promise.allSettled(ownership.map((result, index) => (
            result.status === "fulfilled"
              ? Promise.resolve(result.value)
              : owns(workspaces[index].id)
          )))
        }
        const failed = ownership.find((result) => result.status === "rejected")
        if (failed) {
          this.options.logger.warn({ err: failed.reason, location }, "Failed to resolve instance event location owner")
        }
        const currentIds = new Set(this.options.workspaceManager.list().map((workspace) => workspace.id))
        return ownership.flatMap((result, index) => {
          const id = workspaces[index].id
          return result.status === "fulfilled" && result.value && currentIds.has(id) ? [id] : []
        })
      })
    const entry = { expiresAt: Number.POSITIVE_INFINITY, owners }
    this.locationOwners.set(key, entry)
    const settle = () => { entry.expiresAt = Date.now() + LOCATION_OWNER_CACHE_MS }
    void owners.then(settle, settle)
    return owners
  }

  private clearLocationCaches(): void {
    this.locationOwners.clear()
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
      const timeout = setTimeout(resolve, duration)
      this.controller.signal.addEventListener("abort", () => {
        clearTimeout(timeout)
        resolve()
      }, { once: true })
    })
  }
}
