import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import { AutoAcceptStore } from "./auto-accept-store"

/**
 * Server-side owner of Yolo (permission auto-accept).
 *
 * Subscribes to the instance SSE stream that the server already consumes
 * (`InstanceEventBridge` -> EventBus `instance.event`) and:
 *   - maintains a per-instance session tree so family-root inheritance can
 *     be resolved identically to the previous frontend implementation
 *   - when a permission request arrives for an enabled family, auto-replies
 *     via the injected {@link PermissionReplier} (same `"once"` semantics the
 *     UI used to send)
 *   - emits `yolo.stateChanged` / `yolo.autoAccepted` events on the EventBus
 *     so the UI stays a pure view
 */

export type PermissionSource = "v2" | "legacy"
export type PermissionReplyValue = "once"

export interface AutoAcceptReply {
  instanceId: string
  permissionId: string
  sessionId: string
  source: PermissionSource
  reply: PermissionReplyValue
}

export type PermissionReplier = (reply: AutoAcceptReply) => Promise<void>

interface AutoAcceptManagerDeps {
  eventBus: EventBus
  logger: Logger
  replier: PermissionReplier
}

const PERMISSION_EVENT_TYPES = new Set(["permission.v2.asked", "permission.asked", "permission.updated"])
const SESSION_UPSERT_TYPES = new Set(["session.updated", "session.created"])
const SESSION_REMOVE_TYPES = new Set(["session.deleted"])

export class AutoAcceptManager {
  private readonly store = new AutoAcceptStore()
  /** instanceId:permissionId entries currently being replied, to dedupe re-emissions */
  private readonly inFlight = new Set<string>()
  private unsubscribe?: () => void

  constructor(private readonly deps: AutoAcceptManagerDeps) {}

  start(): void {
    if (this.unsubscribe) return
    const handler = (payload: { instanceId?: string; event?: InstanceStreamPayload }) => {
      if (!payload || !payload.instanceId || !payload.event) return
      this.handleInstanceEvent(payload.instanceId, payload.event)
    }
    const onStopped = (event: { workspaceId?: string }) => {
      if (event?.workspaceId) this.clearInstance(event.workspaceId)
    }
    const onError = (event: { workspace?: { id?: string } }) => {
      if (event?.workspace?.id) this.clearInstance(event.workspace.id)
    }
    this.deps.eventBus.on("instance.event", handler)
    this.deps.eventBus.on("workspace.stopped", onStopped)
    this.deps.eventBus.on("workspace.error", onError)
    this.unsubscribe = () => {
      this.deps.eventBus.off("instance.event", handler)
      this.deps.eventBus.off("workspace.stopped", onStopped)
      this.deps.eventBus.off("workspace.error", onError)
    }
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  isEnabled(instanceId: string, sessionId: string): boolean {
    return this.store.isEnabled(instanceId, sessionId)
  }

  toggle(instanceId: string, sessionId: string): boolean {
    const enabled = this.store.toggle(instanceId, sessionId)
    this.deps.eventBus.publish({ type: "yolo.stateChanged", instanceId, sessionId, enabled })
    return enabled
  }

  clearInstance(instanceId: string): void {
    this.store.clearInstance(instanceId)
  }

  handleInstanceEvent(instanceId: string, event: InstanceStreamPayload): void {
    if (!event || typeof event.type !== "string") return

    if (SESSION_UPSERT_TYPES.has(event.type)) {
      this.ingestSession(instanceId, event.properties)
      return
    }
    if (SESSION_REMOVE_TYPES.has(event.type)) {
      const info = (event.properties as { info?: SessionProperties } | undefined)?.info
      const id = readString(info?.id) ?? readString(event.properties?.id)
      if (id) this.store.removeSession(instanceId, id)
      return
    }
    if (PERMISSION_EVENT_TYPES.has(event.type)) {
      this.maybeAutoAccept(instanceId, event.type, event.properties)
    }
  }

  private ingestSession(instanceId: string, properties: unknown): void {
    // OpenCode wraps session records under `properties.info` for
    // session.created/updated/deleted (see SDK EventSessionUpdated). Accept a
    // flat fallback only for defensive compatibility.
    const info = (properties as { info?: SessionProperties } | SessionProperties | undefined)
    const session = (info && typeof info === "object" && "info" in info ? info.info : info) as
      | SessionProperties
      | undefined
    if (!session || typeof session.id !== "string") return
    const parentId = session.parentID ?? session.parentId ?? null
    const revert = session.revert ?? undefined
    this.store.upsertSession(instanceId, { id: session.id, parentId, revert })
  }

  private maybeAutoAccept(instanceId: string, eventType: string, permission: unknown): void {
    const request = permission as PermissionProperties | undefined
    if (!request) return
    const permissionId = readString(request.id)
    const sessionId = readString(request.sessionID) ?? readString(request.sessionId)
    if (!permissionId || !sessionId) return
    if (!this.store.isEnabled(instanceId, sessionId)) return

    const key = `${instanceId}:${permissionId}`
    if (this.inFlight.has(key)) return
    this.inFlight.add(key)

    const source: PermissionSource = eventType === "permission.v2.asked" ? "v2" : "legacy"
    const reply: AutoAcceptReply = { instanceId, permissionId, sessionId, source, reply: "once" }

    void this.deps.replier(reply)
      .then(() => {
        this.deps.eventBus.publish({ type: "yolo.autoAccepted", instanceId, sessionId, permissionId })
      })
      .catch((error) => {
        this.deps.logger.error({ instanceId, permissionId, err: error }, "Yolo auto-accept reply failed")
      })
      .finally(() => {
        this.inFlight.delete(key)
      })
  }
}

interface InstanceStreamPayload {
  type?: string
  properties?: Record<string, unknown>
}

interface SessionProperties {
  id?: string
  parentID?: string | null
  parentId?: string | null
  revert?: unknown
}

interface PermissionProperties {
  id?: string
  sessionID?: string
  sessionId?: string
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
