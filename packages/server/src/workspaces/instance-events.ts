import type { OpenCodeEvent } from "@opencode-ai/client"
import { EventBus } from "../events/bus"
import { Logger } from "../logger"
import { WorkspaceManager } from "./manager"
import { InstanceStreamEvent, InstanceStreamStatus } from "../api-types"

const RECONNECT_DELAY_MS = 1000
const DIRECTORY_OWNER_CACHE_MS = 2000
const SESSION_DIRECTORY_CACHE_MS = 2000

interface InstanceEventBridgeOptions {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
}

export class InstanceEventBridge {
  private readonly controller = new AbortController()
  private status: InstanceStreamStatus = "connecting"
  private task?: Promise<void>
  private readonly directoryOwners = new Map<string, { expiresAt: number; owners: Promise<string[]> }>()
  private readonly sessionDirectories = new Map<string, { expiresAt: number; directory: Promise<string | undefined> }>()
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
      this.updateStatus("connecting")
      try {
        const events = await this.options.workspaceManager.subscribeToSharedService(this.controller.signal)
        this.updateStatus("connected")
        for await (const event of events) {
          if (this.controller.signal.aborted) return
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
    const sessionId = this.sessionId(event)
    if (event.type === "session.moved" && sessionId) this.sessionDirectories.delete(sessionId)

    const directory = event.location?.directory ?? (sessionId ? await this.resolveSessionDirectory(sessionId) : undefined)
    if (!directory) {
      if (event.type === "session.deleted" && sessionId) {
        // Deletion can make session.get return 404 before the event arrives. Session IDs are
        // service-global, so notifying every logical workspace cannot delete another session.
        const compatibleEvent: InstanceStreamEvent = {
          ...event,
          properties: this.compatibilityProperties(event),
        }
        for (const workspace of this.options.workspaceManager.list()) {
          this.options.eventBus.publish({ type: "instance.event", instanceId: workspace.id, event: compatibleEvent })
        }
        this.sessionDirectories.delete(sessionId)
      }
      return
    }
    if (sessionId) {
      this.sessionDirectories.set(sessionId, {
        expiresAt: Date.now() + SESSION_DIRECTORY_CACHE_MS,
        directory: Promise.resolve(directory),
      })
    }

    const instanceIds = await this.resolveDirectoryOwners(directory)
    if (instanceIds.length === 0) {
      if (event.type === "session.deleted" && sessionId) this.sessionDirectories.delete(sessionId)
      return
    }

    // The server's auto-accept boundary still reads the legacy property name.
    const compatibleEvent: InstanceStreamEvent = {
      ...event,
      properties: this.compatibilityProperties(event),
    }
    for (const instanceId of instanceIds) {
      this.options.eventBus.publish({ type: "instance.event", instanceId, event: compatibleEvent })
    }
    if (event.type === "session.deleted" && sessionId) this.sessionDirectories.delete(sessionId)
  }

  private sessionId(event: OpenCodeEvent): string | undefined {
    const sessionId = (event.data as { sessionID?: unknown }).sessionID
    return typeof sessionId === "string" && sessionId ? sessionId : undefined
  }

  private resolveSessionDirectory(sessionId: string): Promise<string | undefined> {
    const now = Date.now()
    const cached = this.sessionDirectories.get(sessionId)
    if (cached && cached.expiresAt > now) return cached.directory

    const directory = this.options.workspaceManager.getSharedServiceClient()
      .then((client) => client.session.get({ sessionID: sessionId }))
      .then((session) => session.location.directory)
      .catch((error) => {
        this.options.logger.warn({ err: error, sessionId }, "Failed to resolve instance event session location")
        return undefined
      })
    this.sessionDirectories.set(sessionId, { expiresAt: now + SESSION_DIRECTORY_CACHE_MS, directory })
    return directory
  }

  private resolveDirectoryOwners(directory: string): Promise<string[]> {
    const now = Date.now()
    const cached = this.directoryOwners.get(directory)
    if (cached && cached.expiresAt > now) return cached.owners

    const workspaces = this.options.workspaceManager.list()
    const owners = Promise.all(workspaces.map((workspace) => (
      this.options.workspaceManager.ownsDirectory(workspace.id, directory)
    )))
      .then((ownership) => workspaces.filter((_, index) => ownership[index]).map((workspace) => workspace.id))
      .catch((error) => {
        this.options.logger.warn({ err: error, directory }, "Failed to resolve instance event directory owner")
        return []
      })
    this.directoryOwners.set(directory, { expiresAt: now + DIRECTORY_OWNER_CACHE_MS, owners })
    return owners
  }

  private clearLocationCaches(): void {
    this.directoryOwners.clear()
    this.sessionDirectories.clear()
  }

  private compatibilityProperties(event: OpenCodeEvent): Record<string, unknown> {
    if (event.type === "session.created") {
      return { info: { ...event.data, id: event.data.sessionID } }
    }
    if (event.type === "session.deleted") {
      return { id: event.data.sessionID }
    }
    return event.data as Record<string, unknown>
  }

  private updateStatus(status: InstanceStreamStatus, reason?: string) {
    this.status = status
    for (const workspace of this.options.workspaceManager.list()) {
      this.publishStatus(workspace.id, status, reason)
    }
  }

  private publishStatus(instanceId: string, status: InstanceStreamStatus, reason?: string) {
    this.options.logger.debug({ instanceId, status, reason }, "Instance event status updated")
    this.options.eventBus.publish({ type: "instance.eventStatus", instanceId, status, reason })
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
