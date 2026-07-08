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

interface PendingPermission {
  permissionId: string
  sessionId: string
  source: PermissionSource
}

interface AutoAcceptManagerDeps {
  eventBus: EventBus
  logger: Logger
  replier: PermissionReplier
}

const PERMISSION_ASK_TYPES = new Set(["permission.v2.asked", "permission.asked", "permission.updated"])
const PERMISSION_REPLIED_TYPES = new Set(["permission.v2.replied", "permission.replied"])
const SESSION_UPSERT_TYPES = new Set(["session.updated", "session.created"])
const SESSION_REMOVE_TYPES = new Set(["session.deleted"])

export class AutoAcceptManager {
  private static readonly MAX_REPLY_ATTEMPTS = 3
  private readonly store = new AutoAcceptStore()
  /** instanceId:permissionId entries currently being replied, to dedupe re-emissions */
  private readonly inFlight = new Set<string>()
  /** instanceId -> (permissionId -> pending permission) awaiting a reply */
  private readonly pending = new Map<string, Map<string, PendingPermission>>()
  /** instanceId:permissionId -> failure count, to stop retrying stuck permissions */
  private readonly replyAttempts = new Map<string, number>()
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
    if (enabled) {
      this.drainPending(instanceId, sessionId)
    }
    return enabled
  }

  clearInstance(instanceId: string): void {
    this.store.clearInstance(instanceId)
    this.pending.delete(instanceId)
    const prefix = `${instanceId}:`
    for (const key of Array.from(this.inFlight.keys())) {
      if (key.startsWith(prefix)) this.inFlight.delete(key)
    }
    for (const key of Array.from(this.replyAttempts.keys())) {
      if (key.startsWith(prefix)) this.replyAttempts.delete(key)
    }
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
      if (id) {
        this.store.removeSession(instanceId, id)
        this.removePendingForSession(instanceId, id)
      }
      return
    }
    if (PERMISSION_REPLIED_TYPES.has(event.type)) {
      this.handlePermissionReplied(instanceId, event.properties)
      return
    }
    if (PERMISSION_ASK_TYPES.has(event.type)) {
      this.handlePermissionRequest(instanceId, event.type, event.properties)
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
    // Session ancestry may have changed (parent discovered, revert toggled).
    // Re-drain pending permissions whose family root may have migrated into
    // an enabled family — mirrors the old UI's drainAutoAcceptPermissions-
    // ForInstance trigger on session.updated (#497).
    this.drainPending(instanceId, session.id)
  }

  private handlePermissionRequest(instanceId: string, eventType: string, permission: unknown): void {
    const request = permission as PermissionProperties | undefined
    if (!request) return
    const permissionId = readString(request.id)
    const sessionId = readString(request.sessionID) ?? readString(request.sessionId)
    if (!permissionId || !sessionId) return

    // Infer source from the event type, but prefer the already-tracked source
    // for permission.updated (which may belong to a v2 permission).
    const existing = this.pending.get(instanceId)?.get(permissionId)
    const source: PermissionSource = eventType === "permission.v2.asked" ? "v2" : (existing?.source ?? "legacy")

    // `permission.updated` represents a detail change for a permission that
    // is *already* pending. If it is no longer in our pending set it was
    // already replied to (by us or the user) — skip to avoid a duplicate reply.
    if (eventType === "permission.updated" && !this.pending.get(instanceId)?.has(permissionId)) {
      return
    }

    this.addPending(instanceId, { permissionId, sessionId, source })

    if (!this.store.isEnabled(instanceId, sessionId)) return
    this.tryAutoAccept(instanceId, permissionId, sessionId, source)
  }

  private handlePermissionReplied(instanceId: string, properties: unknown): void {
    const request = (properties as PermissionRepliedProperties | undefined) ?? {}
    const permissionId =
      readString(request.id) ??
      readString(request.requestID) ??
      readString(request.permissionID) ??
      readString(request.requestId) ??
      readString(request.permissionId)
    if (permissionId) this.removePending(instanceId, permissionId)
  }

  private tryAutoAccept(
    instanceId: string,
    permissionId: string,
    sessionId: string,
    source: PermissionSource,
  ): void {
    const key = `${instanceId}:${permissionId}`
    if (this.inFlight.has(key)) return
    const attempts = this.replyAttempts.get(key) ?? 0
    if (attempts >= AutoAcceptManager.MAX_REPLY_ATTEMPTS) return
    this.inFlight.add(key)
    this.replyAttempts.set(key, attempts + 1)

    const reply: AutoAcceptReply = { instanceId, permissionId, sessionId, source, reply: "once" }

    void this.deps.replier(reply)
      .then(() => {
        this.replyAttempts.delete(key)
        this.removePending(instanceId, permissionId)
        this.deps.eventBus.publish({ type: "yolo.autoAccepted", instanceId, sessionId, permissionId })
      })
      .catch((error) => {
        this.deps.logger.error({ instanceId, permissionId, err: error, attempt: attempts + 1 }, "Yolo auto-accept reply failed")
        if (attempts + 1 >= AutoAcceptManager.MAX_REPLY_ATTEMPTS) {
          this.removePending(instanceId, permissionId)
        }
      })
      .finally(() => {
        this.inFlight.delete(key)
      })
  }

  /** Auto-accept all pending permissions belonging to the same family root. */
  private drainPending(instanceId: string, sessionId: string): void {
    const instancePending = this.pending.get(instanceId)
    if (!instancePending || instancePending.size === 0) return
    const root = this.store.familyRoot(instanceId, sessionId)
    for (const entry of Array.from(instancePending.values())) {
      if (this.store.familyRoot(instanceId, entry.sessionId) === root) {
        this.tryAutoAccept(instanceId, entry.permissionId, entry.sessionId, entry.source)
      }
    }
  }

  private addPending(instanceId: string, entry: PendingPermission): void {
    let instancePending = this.pending.get(instanceId)
    if (!instancePending) {
      instancePending = new Map()
      this.pending.set(instanceId, instancePending)
    }
    instancePending.set(entry.permissionId, entry)
  }

  private removePending(instanceId: string, permissionId: string): void {
    const instancePending = this.pending.get(instanceId)
    if (instancePending?.delete(permissionId)) {
      this.replyAttempts.delete(`${instanceId}:${permissionId}`)
      if (instancePending.size === 0) this.pending.delete(instanceId)
    }
  }

  private removePendingForSession(instanceId: string, sessionId: string): void {
    const instancePending = this.pending.get(instanceId)
    if (!instancePending) return
    for (const [permId, entry] of Array.from(instancePending)) {
      if (entry.sessionId === sessionId) {
        instancePending.delete(permId)
        this.replyAttempts.delete(`${instanceId}:${permId}`)
      }
    }
    if (instancePending.size === 0) this.pending.delete(instanceId)
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

interface PermissionRepliedProperties {
  id?: string
  requestID?: string
  permissionID?: string
  requestId?: string
  permissionId?: string
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}
