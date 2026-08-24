import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import { AutoAcceptStore, type AutoAcceptSessionInfo } from "./auto-accept-store"

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
  persistence?: AutoAcceptPersistence
}

export interface PersistedAutoAcceptSession extends AutoAcceptSessionInfo {
  yoloEnabled: boolean
  workspaceId?: string
}

export interface AutoAcceptPersistence {
  loadSessions(instanceId: string): Promise<PersistedAutoAcceptSession[]>
  persist(instanceId: string, rootSessionId: string, enabled: boolean, workspaceId?: string): Promise<void>
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
  private readonly hydratedInstances = new Set<string>()
  private readonly hydration = new Map<string, Promise<void>>()
  private readonly queuedEvents = new Map<string, InstanceStreamPayload[]>()
  private readonly instanceGeneration = new Map<string, number>()
  private readonly sessionWorkspaces = new Map<string, Map<string, string>>()
  private readonly mutations = new Map<string, Promise<boolean>>()
  private unsubscribe?: () => void

  constructor(private readonly deps: AutoAcceptManagerDeps) {}

  start(): void {
    if (this.unsubscribe) return
    const handler = (payload: { instanceId?: string; event?: InstanceStreamPayload }) => {
      if (!payload || !payload.instanceId || !payload.event) return
      if (this.deps.persistence && !this.hydratedInstances.has(payload.instanceId)) {
        const queued = this.queuedEvents.get(payload.instanceId) ?? []
        queued.push(payload.event)
        this.queuedEvents.set(payload.instanceId, queued)
        void this.hydrateInstance(payload.instanceId).catch((error) => {
          this.deps.logger.warn({ instanceId: payload.instanceId, err: error }, "Failed to hydrate persisted Yolo state")
        })
        return
      }
      this.handleInstanceEvent(payload.instanceId, payload.event)
    }
    const onStarted = (event: { workspace?: { id?: string } }) => {
      const instanceId = event.workspace?.id
      if (!instanceId) return
      void this.hydrateInstance(instanceId).catch((error) => {
        this.deps.logger.warn({ instanceId, err: error }, "Failed to hydrate persisted Yolo state")
      })
    }
    const onStopped = (event: { workspaceId?: string }) => {
      if (event?.workspaceId) this.clearInstance(event.workspaceId)
    }
    const onError = (event: { workspace?: { id?: string } }) => {
      if (event?.workspace?.id) this.clearInstance(event.workspace.id)
    }
    this.deps.eventBus.on("instance.event", handler)
    this.deps.eventBus.on("workspace.started", onStarted)
    this.deps.eventBus.on("workspace.stopped", onStopped)
    this.deps.eventBus.on("workspace.error", onError)
    this.unsubscribe = () => {
      this.deps.eventBus.off("instance.event", handler)
      this.deps.eventBus.off("workspace.started", onStarted)
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

  hydrateInstance(instanceId: string): Promise<void> {
    if (!this.deps.persistence || this.hydratedInstances.has(instanceId)) return Promise.resolve()
    const existing = this.hydration.get(instanceId)
    if (existing) return existing
    const generation = this.instanceGeneration.get(instanceId) ?? 0
    let hydrated = false
    const pending = this.deps.persistence.loadSessions(instanceId).then((sessions) => {
      if ((this.instanceGeneration.get(instanceId) ?? 0) !== generation) return
      this.store.clearInstance(instanceId)
      const workspaces = new Map<string, string>()
      for (const session of sessions) {
        this.store.upsertSession(instanceId, session)
        if (session.workspaceId) workspaces.set(session.id, session.workspaceId)
      }
      this.sessionWorkspaces.set(instanceId, workspaces)
      for (const session of sessions) {
        if (!session.yoloEnabled || this.store.familyRoot(instanceId, session.id) !== session.id) continue
        this.store.setEnabled(instanceId, session.id, true)
        this.deps.eventBus.publish({ type: "yolo.stateChanged", instanceId, sessionId: session.id, enabled: true })
        this.drainPending(instanceId, session.id)
      }
      this.hydratedInstances.add(instanceId)
      hydrated = true
    }).finally(() => {
      if ((this.instanceGeneration.get(instanceId) ?? 0) !== generation) return
      this.hydration.delete(instanceId)
      if (!hydrated) return
      const queued = this.queuedEvents.get(instanceId) ?? []
      this.queuedEvents.delete(instanceId)
      for (const event of queued) this.handleInstanceEvent(instanceId, event)
    })
    this.hydration.set(instanceId, pending)
    return pending
  }

  toggle(instanceId: string, sessionId: string): boolean | Promise<boolean> {
    if (this.deps.persistence) return this.togglePersisted(instanceId, sessionId)
    const enabled = this.store.toggle(instanceId, sessionId)
    this.deps.eventBus.publish({ type: "yolo.stateChanged", instanceId, sessionId, enabled })
    if (enabled) {
      this.drainPending(instanceId, sessionId)
    }
    return enabled
  }

  private async togglePersisted(instanceId: string, sessionId: string): Promise<boolean> {
    await this.hydrateInstance(instanceId)
    const generation = this.instanceGeneration.get(instanceId) ?? 0
    const mutation = (this.mutations.get(instanceId) ?? Promise.resolve(false)).catch(() => false).then(async () => {
      if ((this.instanceGeneration.get(instanceId) ?? 0) !== generation) {
        return this.store.isEnabled(instanceId, sessionId)
      }
      const rootSessionId = this.store.familyRoot(instanceId, sessionId)
      const traversedRootSessionIds = new Set([rootSessionId])
      const enabled = !this.store.isEnabled(instanceId, rootSessionId)
      await this.deps.persistence!.persist(
        instanceId,
        rootSessionId,
        enabled,
        this.sessionWorkspaces.get(instanceId)?.get(rootSessionId),
      )
      if ((this.instanceGeneration.get(instanceId) ?? 0) !== generation) {
        return this.store.isEnabled(instanceId, rootSessionId)
      }
      let persistedRootSessionId = rootSessionId
      let currentRootSessionId = this.store.familyRoot(instanceId, sessionId)
      while (currentRootSessionId !== persistedRootSessionId) {
        traversedRootSessionIds.add(currentRootSessionId)
        await this.deps.persistence!.persist(
          instanceId,
          currentRootSessionId,
          enabled,
          this.sessionWorkspaces.get(instanceId)?.get(currentRootSessionId),
        )
        if (enabled) {
          await this.deps.persistence!.persist(
            instanceId,
            persistedRootSessionId,
            false,
            this.sessionWorkspaces.get(instanceId)?.get(persistedRootSessionId),
          )
        }
        persistedRootSessionId = currentRootSessionId
        currentRootSessionId = this.store.familyRoot(instanceId, sessionId)
      }
      if ((this.instanceGeneration.get(instanceId) ?? 0) !== generation) {
        return this.store.isEnabled(instanceId, currentRootSessionId)
      }
      if (enabled) {
        this.store.setEnabled(instanceId, currentRootSessionId, true)
      } else {
        for (const traversedRootSessionId of traversedRootSessionIds) {
          this.store.setEnabled(instanceId, traversedRootSessionId, false)
        }
      }
      this.deps.eventBus.publish({ type: "yolo.stateChanged", instanceId, sessionId: currentRootSessionId, enabled })
      if (enabled) this.drainPending(instanceId, currentRootSessionId)
      return enabled
    })
    const settled = mutation.finally(() => {
      if (this.mutations.get(instanceId) === settled) this.mutations.delete(instanceId)
    })
    this.mutations.set(instanceId, settled)
    return settled
  }

  clearInstance(instanceId: string): void {
    this.instanceGeneration.set(instanceId, (this.instanceGeneration.get(instanceId) ?? 0) + 1)
    this.hydratedInstances.delete(instanceId)
    this.hydration.delete(instanceId)
    this.queuedEvents.delete(instanceId)
    this.sessionWorkspaces.delete(instanceId)
    this.mutations.delete(instanceId)
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
    const enabledBefore = this.store.enabledRoots(instanceId)
    this.store.upsertSession(instanceId, { id: session.id, parentId, revert })
    if (typeof session.workspaceID === "string" && session.workspaceID) {
      const workspaces = this.sessionWorkspaces.get(instanceId) ?? new Map<string, string>()
      workspaces.set(session.id, session.workspaceID)
      this.sessionWorkspaces.set(instanceId, workspaces)
    }
    this.persistRootMigration(instanceId, enabledBefore, this.store.enabledRoots(instanceId))
    // Session ancestry may have changed (parent discovered, revert toggled).
    // Re-drain pending permissions whose family root may have migrated into
    // an enabled family — mirrors the old UI's drainAutoAcceptPermissions-
    // ForInstance trigger on session.updated (#497).
    this.drainPending(instanceId, session.id)
  }

  private persistRootMigration(instanceId: string, before: readonly string[], after: readonly string[]): void {
    if (!this.deps.persistence) return
    const removed = before.filter((id) => !after.includes(id))
    const added = after.filter((id) => !before.includes(id))
    if (removed.length === 0 && added.length === 0) return
    const generation = this.instanceGeneration.get(instanceId) ?? 0
    const mutation = (this.mutations.get(instanceId) ?? Promise.resolve(false)).catch(() => false).then(async () => {
      if ((this.instanceGeneration.get(instanceId) ?? 0) !== generation) return false
      const enabledRoots = new Set(this.store.enabledRoots(instanceId))
      for (const rootSessionId of added) {
        if (!enabledRoots.has(rootSessionId)) continue
        await this.deps.persistence!.persist(
          instanceId, rootSessionId, true, this.sessionWorkspaces.get(instanceId)?.get(rootSessionId),
        )
      }
      for (const rootSessionId of removed) {
        if (enabledRoots.has(rootSessionId)) continue
        if ((this.instanceGeneration.get(instanceId) ?? 0) !== generation) return false
        await this.deps.persistence!.persist(
          instanceId, rootSessionId, false, this.sessionWorkspaces.get(instanceId)?.get(rootSessionId),
        )
      }
      return false
    })
    const settled = mutation.finally(() => {
      if (this.mutations.get(instanceId) === settled) this.mutations.delete(instanceId)
    })
    this.mutations.set(instanceId, settled)
    void settled.catch((error) => {
      this.deps.logger.warn({ instanceId, err: error }, "Failed to migrate persisted Yolo family root")
    })
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
  workspaceID?: string
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
