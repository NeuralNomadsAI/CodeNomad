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

export type PermissionReplier = (reply: AutoAcceptReply, signal: AbortSignal) => Promise<void>

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
  loadSessions(instanceId: string, signal: AbortSignal): Promise<PersistedAutoAcceptSession[]>
  persist(
    instanceId: string,
    rootSessionId: string,
    enabled: boolean,
    workspaceId: string | undefined,
    signal: AbortSignal,
  ): Promise<void>
}

const PERMISSION_ASK_TYPES = new Set(["permission.v2.asked", "permission.asked", "permission.updated"])
const PERMISSION_REPLIED_TYPES = new Set(["permission.v2.replied", "permission.replied"])
const SESSION_UPSERT_TYPES = new Set(["session.updated", "session.created"])
const SESSION_REMOVE_TYPES = new Set(["session.deleted"])
const REBIND_TOGGLE_AFTER_ROTATION = new Error("Rebind Yolo toggle after runtime rotation")

export class AutoAcceptManager {
  private static readonly MAX_REPLY_ATTEMPTS = 3
  private static readonly MAX_HYDRATION_RETRY_ATTEMPTS = 3
  private static readonly HYDRATION_RETRY_MS = 10
  private static readonly MAX_QUEUED_EVENTS_PER_INSTANCE = 512
  private static readonly MAX_PENDING_PER_INSTANCE = 512
  private static readonly MAX_REBOUND_MIGRATION_ATTEMPTS = 3
  private static readonly REBOUND_MIGRATION_RETRY_MS = 10
  private readonly store = new AutoAcceptStore()
  /** instanceId:permissionId entries currently being replied, to dedupe re-emissions */
  private readonly inFlight = new Set<string>()
  /** instanceId -> (permissionId -> pending permission) awaiting a reply */
  private readonly pending = new Map<string, Map<string, PendingPermission>>()
  /** instanceId:permissionId -> failure count, to stop retrying stuck permissions */
  private readonly replyAttempts = new Map<string, number>()
  private readonly hydratedInstances = new Set<string>()
  private readonly hydration = new Map<string, Promise<void>>()
  private readonly failedHydrations = new Set<string>()
  private readonly queuedEvents = new Map<string, Map<string, InstanceStreamPayload>>()
  private readonly overflowedEventQueues = new Set<string>()
  private readonly instanceGeneration = new Map<string, number>()
  private readonly generationControllers = new Map<string, AbortController>()
  private readonly streamIds = new Map<string, string>()
  private readonly sessionWorkspaces = new Map<string, Map<string, string>>()
  private readonly persistedEnabledSessions = new Map<string, Set<string>>()
  private readonly reboundRootMigrations = new Map<string, Set<string>>()
  private readonly reboundRootMigrationAttempts = new Map<string, number>()
  private readonly reboundRootMigrationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly reboundRootMigrationRuns = new Set<string>()
  private readonly mutations = new Map<string, Promise<boolean>>()
  private unsubscribe?: () => void
  private stopped = false

  constructor(private readonly deps: AutoAcceptManagerDeps) {}

  start(): void {
    if (this.unsubscribe) return
    this.stopped = false
    const handler = (payload: { instanceId?: string; streamId?: string; event?: InstanceStreamPayload }) => {
      if (!payload || !payload.instanceId || !payload.event) return
      if (payload.streamId) {
        const current = this.streamIds.get(payload.instanceId)
        if (current && current !== payload.streamId) return
        this.streamIds.set(payload.instanceId, payload.streamId)
      }
      if (this.deps.persistence && !this.hydratedInstances.has(payload.instanceId)) {
        this.queueEvent(payload.instanceId, payload.event)
        if (this.failedHydrations.has(payload.instanceId)) return
        void this.beginHydration(payload.instanceId).catch((error) => {
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
    const onStreamStatus = (event: { instanceId?: string; streamId?: string; status?: string }) => {
      if (!event.instanceId || !event.streamId || event.status !== "connecting") return
      const current = this.streamIds.get(event.instanceId)
      if (current && current !== event.streamId) {
        this.invalidateRuntimeState(event.instanceId)
        this.streamIds.set(event.instanceId, event.streamId)
        void this.hydrateInstance(event.instanceId).catch((error) => {
          this.deps.logger.warn({ instanceId: event.instanceId, err: error }, "Failed to hydrate persisted Yolo state")
        })
        return
      }
      this.streamIds.set(event.instanceId, event.streamId)
    }
    this.deps.eventBus.on("instance.event", handler)
    this.deps.eventBus.on("instance.eventStatus", onStreamStatus)
    this.deps.eventBus.on("workspace.started", onStarted)
    this.deps.eventBus.on("workspace.stopped", onStopped)
    this.deps.eventBus.on("workspace.error", onError)
    this.unsubscribe = () => {
      this.deps.eventBus.off("instance.event", handler)
      this.deps.eventBus.off("instance.eventStatus", onStreamStatus)
      this.deps.eventBus.off("workspace.started", onStarted)
      this.deps.eventBus.off("workspace.stopped", onStopped)
      this.deps.eventBus.off("workspace.error", onError)
    }
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.stopped = true
    const instanceIds = new Set([
      ...this.generationControllers.keys(),
      ...this.instanceGeneration.keys(),
      ...this.streamIds.keys(),
      ...this.hydratedInstances,
      ...this.hydration.keys(),
      ...this.failedHydrations,
      ...this.queuedEvents.keys(),
      ...this.overflowedEventQueues,
      ...this.sessionWorkspaces.keys(),
      ...this.persistedEnabledSessions.keys(),
      ...this.mutations.keys(),
      ...this.pending.keys(),
    ])
    for (const instanceId of instanceIds) this.invalidateRuntimeState(instanceId)
    for (const instanceId of this.reboundRootMigrationTimers.keys()) this.clearReboundRootMigrationRetry(instanceId)
    this.reboundRootMigrations.clear()
    this.reboundRootMigrationRuns.clear()
    this.streamIds.clear()
  }

  isEnabled(instanceId: string, sessionId: string): boolean {
    return this.store.isEnabled(instanceId, sessionId)
  }

  hydrateInstance(instanceId: string): Promise<void> {
    this.failedHydrations.delete(instanceId)
    return this.beginHydration(instanceId)
  }

  private beginHydration(instanceId: string): Promise<void> {
    if (this.stopped || !this.deps.persistence || this.hydratedInstances.has(instanceId)) return Promise.resolve()
    const existing = this.hydration.get(instanceId)
    if (existing) return existing
    const generation = this.instanceGeneration.get(instanceId) ?? 0
    const pending = this.runHydrationSequence(instanceId, generation).then(async (hydrated) => {
      while (hydrated && this.overflowedEventQueues.delete(instanceId)) {
        hydrated = await this.runHydrationSequence(instanceId, generation)
      }
      if (!hydrated) return
      const queued = this.queuedEvents.get(instanceId)
      for (const event of queued?.values() ?? []) {
        if (isSessionEvent(event)) this.handleInstanceEvent(instanceId, event)
      }
      if (!this.hasRuntimeAuthority(instanceId, generation, this.generationSignal(instanceId))) return
      this.hydratedInstances.add(instanceId)
      this.queuedEvents.delete(instanceId)
      for (const event of queued?.values() ?? []) {
        if (!isSessionEvent(event)) this.handleInstanceEvent(instanceId, event)
      }
      void this.retryReboundRootMigrations(instanceId)
    }).finally(() => {
      if (this.hydration.get(instanceId) !== pending) return
      this.hydration.delete(instanceId)
    })
    this.hydration.set(instanceId, pending)
    return pending
  }

  private async runHydrationSequence(instanceId: string, generation: number): Promise<boolean> {
    for (let attempt = 0; attempt <= AutoAcceptManager.MAX_HYDRATION_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const hydrated = await this.hydrateInstanceOnce(instanceId, generation)
        if (hydrated) this.failedHydrations.delete(instanceId)
        return hydrated
      } catch (error) {
        if (this.stopped || (this.instanceGeneration.get(instanceId) ?? 0) !== generation) return false
        if (attempt === AutoAcceptManager.MAX_HYDRATION_RETRY_ATTEMPTS) {
          this.failedHydrations.add(instanceId)
          throw error
        }
        this.deps.logger.warn({ instanceId, err: error, attempt: attempt + 1 }, "Failed to hydrate persisted Yolo state; retrying")
        await new Promise<void>((resolve) => setTimeout(resolve, AutoAcceptManager.HYDRATION_RETRY_MS * (attempt + 1)))
      }
    }
    return false
  }

  private async hydrateInstanceOnce(instanceId: string, generation: number): Promise<boolean> {
    const signal = this.generationSignal(instanceId)
    const priorMutation = this.mutations.get(instanceId)
    const load = priorMutation
      ? priorMutation.catch(() => false).then(() => {
          if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return undefined
          return this.deps.persistence!.loadSessions(instanceId, signal)
        })
      : this.deps.persistence!.loadSessions(instanceId, signal)
    try {
      const sessions = await load
      if (!sessions) return false
      if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return false
      this.store.clearInstance(instanceId)
      const workspaces = new Map<string, string>()
      for (const session of sessions) {
        this.store.upsertSession(instanceId, session)
        if (session.workspaceId) workspaces.set(session.id, session.workspaceId)
      }
      this.sessionWorkspaces.set(instanceId, workspaces)
      const persistedEnabled = new Set(sessions.filter((session) => session.yoloEnabled).map((session) => session.id))
      for (const formerRootSessionId of Array.from(persistedEnabled)) {
        const currentRootSessionId = this.store.familyRoot(instanceId, formerRootSessionId)
        if (currentRootSessionId === formerRootSessionId) continue
        await this.deps.persistence!.persist(
          instanceId,
          currentRootSessionId,
          true,
          workspaces.get(currentRootSessionId),
          signal,
        )
        if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return false
        persistedEnabled.add(currentRootSessionId)
        await this.deps.persistence!.persist(
          instanceId,
          formerRootSessionId,
          false,
          workspaces.get(formerRootSessionId),
          signal,
        )
        if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return false
        persistedEnabled.delete(formerRootSessionId)
      }
      this.persistedEnabledSessions.set(instanceId, persistedEnabled)
      for (const rootSessionId of persistedEnabled) {
        if (this.store.familyRoot(instanceId, rootSessionId) !== rootSessionId) continue
        this.store.setEnabled(instanceId, rootSessionId, true)
        this.deps.eventBus.publish({ type: "yolo.stateChanged", instanceId, sessionId: rootSessionId, enabled: true })
        this.drainPending(instanceId, rootSessionId)
      }
      return true
    } catch (error) {
      if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return false
      this.releaseFailedHydration(instanceId, signal)
      throw error
    }
  }

  toggle(instanceId: string, sessionId: string): boolean | Promise<boolean> {
    if (this.stopped) return this.store.isEnabled(instanceId, sessionId)
    if (this.deps.persistence) return this.togglePersisted(instanceId, sessionId)
    const enabled = this.store.toggle(instanceId, sessionId)
    this.deps.eventBus.publish({ type: "yolo.stateChanged", instanceId, sessionId, enabled })
    if (enabled) {
      this.drainPending(instanceId, sessionId)
    }
    return enabled
  }

  private async togglePersisted(instanceId: string, sessionId: string, requestedEnabled?: boolean): Promise<boolean> {
    const generation = this.instanceGeneration.get(instanceId) ?? 0
    const signal = this.generationSignal(instanceId)
    let targetEnabled = requestedEnabled
    await this.hydrateInstance(instanceId)
    const mutation = (this.mutations.get(instanceId) ?? Promise.resolve(false)).catch(() => false).then(async () => {
      if (!this.hasRuntimeAuthority(instanceId, generation, signal)) {
        if (!this.stopped && this.streamIds.has(instanceId)) throw REBIND_TOGGLE_AFTER_ROTATION
        return this.store.isEnabled(instanceId, sessionId)
      }
      const rootSessionId = this.store.familyRoot(instanceId, sessionId)
      const traversedRootSessionIds = new Set([rootSessionId])
      const enabled = targetEnabled ?? !this.store.isEnabled(instanceId, rootSessionId)
      targetEnabled = enabled
      await this.deps.persistence!.persist(
        instanceId,
        rootSessionId,
        enabled,
        this.sessionWorkspaces.get(instanceId)?.get(rootSessionId),
        signal,
      )
      if (!this.hasRuntimeAuthority(instanceId, generation, signal)) {
        return enabled
      }
      this.recordPersistedState(instanceId, rootSessionId, enabled)
      let persistedRootSessionId = rootSessionId
      const persistedDisabledRootSessionIds = enabled ? undefined : new Set([rootSessionId])
      let currentRootSessionId = this.store.familyRoot(instanceId, sessionId)
      while (currentRootSessionId !== persistedRootSessionId) {
        traversedRootSessionIds.add(currentRootSessionId)
        await this.deps.persistence!.persist(
          instanceId,
          currentRootSessionId,
          enabled,
          this.sessionWorkspaces.get(instanceId)?.get(currentRootSessionId),
          signal,
        )
        if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return enabled
        this.recordPersistedState(instanceId, currentRootSessionId, enabled)
        persistedDisabledRootSessionIds?.add(currentRootSessionId)
        if (enabled) {
          await this.deps.persistence!.persist(
            instanceId,
            persistedRootSessionId,
            false,
            this.sessionWorkspaces.get(instanceId)?.get(persistedRootSessionId),
            signal,
          )
          if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return enabled
          this.recordPersistedState(instanceId, persistedRootSessionId, false)
        }
        persistedRootSessionId = currentRootSessionId
        currentRootSessionId = this.store.familyRoot(instanceId, sessionId)
      }
      if (!this.hasRuntimeAuthority(instanceId, generation, signal)) {
        return enabled
      }
      if (!enabled) {
        const persistedEnabled = this.persistedEnabledSessions.get(instanceId) ?? new Set<string>()
        const migrations = this.reboundRootMigrations.get(instanceId) ?? new Set<string>()
        for (const durableRootSessionId of new Set([...persistedEnabled, ...migrations])) {
          if (
            persistedDisabledRootSessionIds!.has(durableRootSessionId) ||
            this.store.familyRoot(instanceId, durableRootSessionId) !== currentRootSessionId
          ) continue
          await this.deps.persistence!.persist(
            instanceId,
            durableRootSessionId,
            false,
            this.sessionWorkspaces.get(instanceId)?.get(durableRootSessionId),
            signal,
          )
          if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return enabled
          this.recordPersistedState(instanceId, durableRootSessionId, false)
        }
      }
      this.reconcileReboundRootMigrationsAfterToggle(instanceId, currentRootSessionId, enabled)
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
    }).catch((error) => {
      if (error === REBIND_TOGGLE_AFTER_ROTATION) throw error
      if (!this.hasRuntimeAuthority(instanceId, generation, signal)) {
        if (!this.stopped && this.streamIds.has(instanceId)) throw error
        return this.store.isEnabled(instanceId, sessionId)
      }
      throw error
    })
    const settled = mutation.finally(() => {
      if (this.mutations.get(instanceId) === settled) this.mutations.delete(instanceId)
    })
    this.mutations.set(instanceId, settled)
    try {
      const enabled = await settled
      if (!this.hasRuntimeAuthority(instanceId, generation, signal) && !this.stopped && this.streamIds.has(instanceId)) {
        return this.rebindToggleAfterRotation(instanceId, sessionId, targetEnabled)
      }
      return enabled
    } catch (error) {
      if (error === REBIND_TOGGLE_AFTER_ROTATION) return this.togglePersisted(instanceId, sessionId, targetEnabled)
      if (!this.hasRuntimeAuthority(instanceId, generation, signal) && !this.stopped && this.streamIds.has(instanceId)) {
        return this.rebindToggleAfterRotation(instanceId, sessionId, targetEnabled)
      }
      throw error
    }
  }

  private async rebindToggleAfterRotation(
    instanceId: string,
    sessionId: string,
    requestedEnabled: boolean | undefined,
  ): Promise<boolean> {
    await this.hydrateInstance(instanceId)
    if (requestedEnabled === undefined) return this.togglePersisted(instanceId, sessionId)
    const rootSessionId = this.store.familyRoot(instanceId, sessionId)
    if (this.store.isEnabled(instanceId, rootSessionId) !== requestedEnabled) {
      return this.togglePersisted(instanceId, sessionId, requestedEnabled)
    }
    // Hydration publishes enabled roots; disabled roots need an explicit UI update.
    if (!requestedEnabled) {
      this.deps.eventBus.publish({ type: "yolo.stateChanged", instanceId, sessionId: rootSessionId, enabled: false })
    }
    return requestedEnabled
  }

  clearInstance(instanceId: string): void {
    this.invalidateRuntimeState(instanceId)
    this.clearReboundRootMigrationRetry(instanceId)
    this.reboundRootMigrations.delete(instanceId)
    this.reboundRootMigrationRuns.delete(instanceId)
    this.streamIds.delete(instanceId)
  }

  private invalidateRuntimeState(instanceId: string): void {
    this.generationControllers.get(instanceId)?.abort()
    this.generationControllers.delete(instanceId)
    this.instanceGeneration.set(instanceId, (this.instanceGeneration.get(instanceId) ?? 0) + 1)
    this.failedHydrations.delete(instanceId)
    this.hydratedInstances.delete(instanceId)
    this.hydration.delete(instanceId)
    this.queuedEvents.delete(instanceId)
    this.overflowedEventQueues.delete(instanceId)
    this.sessionWorkspaces.delete(instanceId)
    this.persistedEnabledSessions.delete(instanceId)
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
    if (this.stopped || !event || typeof event.type !== "string") return

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
    const signal = this.generationSignal(instanceId)
    const mutation = (this.mutations.get(instanceId) ?? Promise.resolve(false)).catch(() => false).then(async () => {
      if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return false
      const enabledRoots = new Set(this.store.enabledRoots(instanceId))
      const migratedRoots = new Set<string>()
      for (const rootSessionId of added) {
        const currentRootSessionId = this.store.familyRoot(instanceId, rootSessionId)
        if (!enabledRoots.has(currentRootSessionId)) continue
        await this.deps.persistence!.persist(
          instanceId,
          currentRootSessionId,
          true,
          this.sessionWorkspaces.get(instanceId)?.get(currentRootSessionId),
          signal,
        )
        migratedRoots.add(currentRootSessionId)
      }
      for (const rootSessionId of removed) {
        if (enabledRoots.has(rootSessionId) || migratedRoots.has(rootSessionId)) continue
        if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return false
        await this.deps.persistence!.persist(
          instanceId, rootSessionId, false, this.sessionWorkspaces.get(instanceId)?.get(rootSessionId), signal,
        )
      }
      if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return false
      const persistedEnabled = this.persistedEnabledSessions.get(instanceId)
      for (const rootSessionId of removed) persistedEnabled?.delete(rootSessionId)
      for (const rootSessionId of migratedRoots) {
        persistedEnabled?.add(rootSessionId)
        if (this.store.isEnabled(instanceId, rootSessionId)) continue
        this.store.setEnabled(instanceId, rootSessionId, true)
        this.deps.eventBus.publish({ type: "yolo.stateChanged", instanceId, sessionId: rootSessionId, enabled: true })
        this.drainPending(instanceId, rootSessionId)
      }
      return false
    })
    const settled = mutation.finally(() => {
      if (this.mutations.get(instanceId) === settled) this.mutations.delete(instanceId)
    })
    this.mutations.set(instanceId, settled)
    void settled.then(
      () => {
        if (!this.hasRuntimeAuthority(instanceId, generation, signal)) {
          this.rebindRootMigration(instanceId, before, after)
        }
      },
      (error) => {
        if (!this.hasRuntimeAuthority(instanceId, generation, signal)) {
          this.rebindRootMigration(instanceId, before, after)
          return
        }
        this.deps.logger.warn({ instanceId, err: error }, "Failed to migrate persisted Yolo family root")
      },
    )
  }

  private rebindRootMigration(instanceId: string, before: readonly string[], after: readonly string[]): void {
    if (this.stopped || !this.streamIds.has(instanceId)) return
    const removed = before.filter((id) => !after.includes(id))
    if (removed.length === 0) return
    const migrations = this.reboundRootMigrations.get(instanceId) ?? new Set<string>()
    const priorSize = migrations.size
    for (const rootSessionId of removed) migrations.add(rootSessionId)
    this.reboundRootMigrations.set(instanceId, migrations)
    if (migrations.size !== priorSize) this.reboundRootMigrationAttempts.delete(instanceId)
    void this.retryReboundRootMigrations(instanceId)
  }

  private async retryReboundRootMigrations(instanceId: string): Promise<void> {
    if (
      this.stopped ||
      !this.streamIds.has(instanceId) ||
      !this.reboundRootMigrations.has(instanceId) ||
      this.reboundRootMigrationRuns.has(instanceId) ||
      this.reboundRootMigrationTimers.has(instanceId)
    ) return
    this.reboundRootMigrationRuns.add(instanceId)
    let retryAfterRotation = false
    try {
      try {
        await this.hydrateInstance(instanceId)
      } catch {
        return
      }
      if (this.stopped || !this.hydratedInstances.has(instanceId) || !this.streamIds.has(instanceId)) return
      const generation = this.instanceGeneration.get(instanceId) ?? 0
      const signal = this.generationSignal(instanceId)
      const mutation = (this.mutations.get(instanceId) ?? Promise.resolve(false)).catch(() => false).then(async () => {
        if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return false
        const migrations = this.reboundRootMigrations.get(instanceId)
        const persistedEnabled = this.persistedEnabledSessions.get(instanceId)
        if (!migrations || !persistedEnabled) return false
        for (const formerRootSessionId of Array.from(migrations)) {
          if (!persistedEnabled.has(formerRootSessionId)) {
            migrations.delete(formerRootSessionId)
            continue
          }
          let persistedRootSessionId = formerRootSessionId
          let currentRootSessionId = this.store.familyRoot(instanceId, formerRootSessionId)
          while (currentRootSessionId !== persistedRootSessionId) {
            await this.deps.persistence!.persist(
              instanceId,
              currentRootSessionId,
              true,
              this.sessionWorkspaces.get(instanceId)?.get(currentRootSessionId),
              signal,
            )
            if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return false
            this.recordPersistedState(instanceId, currentRootSessionId, true)
            await this.deps.persistence!.persist(
              instanceId,
              persistedRootSessionId,
              false,
              this.sessionWorkspaces.get(instanceId)?.get(persistedRootSessionId),
              signal,
            )
            if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return false
            this.recordPersistedState(instanceId, persistedRootSessionId, false)
            persistedRootSessionId = currentRootSessionId
            currentRootSessionId = this.store.familyRoot(instanceId, formerRootSessionId)
          }
          migrations.delete(formerRootSessionId)
          if (this.store.isEnabled(instanceId, currentRootSessionId)) continue
          this.store.setEnabled(instanceId, currentRootSessionId, true)
          this.deps.eventBus.publish({
            type: "yolo.stateChanged",
            instanceId,
            sessionId: currentRootSessionId,
            enabled: true,
          })
          this.drainPending(instanceId, currentRootSessionId)
        }
        if (migrations.size === 0) this.reboundRootMigrations.delete(instanceId)
        return false
      })
      const settled = mutation.finally(() => {
        if (this.mutations.get(instanceId) === settled) this.mutations.delete(instanceId)
      })
      this.mutations.set(instanceId, settled)
      try {
        await settled
        if (!this.hasRuntimeAuthority(instanceId, generation, signal)) retryAfterRotation = true
        else this.reboundRootMigrationAttempts.delete(instanceId)
      } catch (error) {
        if (!this.hasRuntimeAuthority(instanceId, generation, signal)) {
          retryAfterRotation = true
          return
        }
        const attempt = (this.reboundRootMigrationAttempts.get(instanceId) ?? 0) + 1
        if (attempt >= AutoAcceptManager.MAX_REBOUND_MIGRATION_ATTEMPTS) {
          this.reboundRootMigrationAttempts.delete(instanceId)
          this.deps.logger.warn(
            { instanceId, err: error, attempt },
            "Failed to migrate persisted Yolo family root after retries; retaining recovery intent",
          )
          return
        }
        this.reboundRootMigrationAttempts.set(instanceId, attempt)
        this.deps.logger.warn({ instanceId, err: error, attempt }, "Failed to migrate persisted Yolo family root; retrying")
        this.scheduleReboundRootMigrationRetry(instanceId, attempt)
      }
    } finally {
      this.reboundRootMigrationRuns.delete(instanceId)
      if (retryAfterRotation) void this.retryReboundRootMigrations(instanceId)
    }
  }

  private scheduleReboundRootMigrationRetry(instanceId: string, attempt: number): void {
    if (this.reboundRootMigrationTimers.has(instanceId)) return
    const timer = setTimeout(() => {
      if (this.reboundRootMigrationTimers.get(instanceId) !== timer) return
      this.reboundRootMigrationTimers.delete(instanceId)
      void this.retryReboundRootMigrations(instanceId)
    }, AutoAcceptManager.REBOUND_MIGRATION_RETRY_MS * attempt)
    this.reboundRootMigrationTimers.set(instanceId, timer)
  }

  private clearReboundRootMigrationRetry(instanceId: string): void {
    const timer = this.reboundRootMigrationTimers.get(instanceId)
    if (timer) clearTimeout(timer)
    this.reboundRootMigrationTimers.delete(instanceId)
    this.reboundRootMigrationAttempts.delete(instanceId)
  }

  private recordPersistedState(instanceId: string, rootSessionId: string, enabled: boolean): void {
    const persistedEnabled = this.persistedEnabledSessions.get(instanceId)
    if (enabled) persistedEnabled?.add(rootSessionId)
    else persistedEnabled?.delete(rootSessionId)
  }

  private reconcileReboundRootMigrationsAfterToggle(
    instanceId: string,
    rootSessionId: string,
    enabled: boolean,
  ): void {
    const migrations = this.reboundRootMigrations.get(instanceId)
    if (!migrations) return
    const persistedEnabled = this.persistedEnabledSessions.get(instanceId)
    for (const formerRootSessionId of Array.from(migrations)) {
      if (this.store.familyRoot(instanceId, formerRootSessionId) !== rootSessionId) continue
      if (!enabled || !persistedEnabled?.has(formerRootSessionId) || formerRootSessionId === rootSessionId) {
        migrations.delete(formerRootSessionId)
      }
    }
    if (migrations.size > 0) return
    this.reboundRootMigrations.delete(instanceId)
    this.clearReboundRootMigrationRetry(instanceId)
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
    const generation = this.instanceGeneration.get(instanceId) ?? 0
    const signal = this.generationSignal(instanceId)
    this.inFlight.add(key)
    this.replyAttempts.set(key, attempts + 1)

    const reply: AutoAcceptReply = { instanceId, permissionId, sessionId, source, reply: "once" }

    void this.deps.replier(reply, signal)
      .then(() => {
        if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return
        this.replyAttempts.delete(key)
        this.removePending(instanceId, permissionId)
        this.deps.eventBus.publish({ type: "yolo.autoAccepted", instanceId, sessionId, permissionId })
      })
      .catch((error) => {
        if (!this.hasRuntimeAuthority(instanceId, generation, signal)) return
        this.deps.logger.error({ instanceId, permissionId, err: error, attempt: attempts + 1 }, "Yolo auto-accept reply failed")
        if (attempts + 1 >= AutoAcceptManager.MAX_REPLY_ATTEMPTS) {
          this.removePending(instanceId, permissionId)
        }
      })
      .finally(() => {
        if (this.hasRuntimeAuthority(instanceId, generation, signal)) this.inFlight.delete(key)
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
    if (instancePending.has(entry.permissionId)) instancePending.delete(entry.permissionId)
    instancePending.set(entry.permissionId, entry)
    if (instancePending.size > AutoAcceptManager.MAX_PENDING_PER_INSTANCE) {
      const oldestPermissionId = instancePending.keys().next().value
      if (oldestPermissionId) this.removePending(instanceId, oldestPermissionId)
    }
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

  private generationSignal(instanceId: string): AbortSignal {
    if (this.stopped) {
      const controller = new AbortController()
      controller.abort()
      return controller.signal
    }
    let controller = this.generationControllers.get(instanceId)
    if (!controller || controller.signal.aborted) {
      controller = new AbortController()
      this.generationControllers.set(instanceId, controller)
    }
    return controller.signal
  }

  private releaseFailedHydration(instanceId: string, signal: AbortSignal): void {
    const controller = this.generationControllers.get(instanceId)
    if (controller?.signal !== signal) return
    controller.abort()
    this.generationControllers.delete(instanceId)
  }

  private queueEvent(instanceId: string, event: InstanceStreamPayload): void {
    const key = queuedEventKey(event)
    if (!key) return
    const queued = this.queuedEvents.get(instanceId) ?? new Map<string, InstanceStreamPayload>()
    const existing = queued.get(key)
    let next = event
    if (existing && PERMISSION_ASK_TYPES.has(existing.type ?? "") && event.type === "permission.updated") {
      next = { ...event, type: existing.type, properties: { ...existing.properties, ...event.properties } }
    }
    queued.delete(key)
    queued.set(key, next)
    if (queued.size > AutoAcceptManager.MAX_QUEUED_EVENTS_PER_INSTANCE) {
      this.overflowedEventQueues.add(instanceId)
      for (const [queuedKey, queuedEvent] of queued) {
        if (!isSessionEvent(queuedEvent)) queued.delete(queuedKey)
      }
      while (queued.size > AutoAcceptManager.MAX_QUEUED_EVENTS_PER_INSTANCE) {
        const oldestKey = queued.keys().next().value
        if (oldestKey) queued.delete(oldestKey)
      }
    }
    this.queuedEvents.set(instanceId, queued)
  }

  private hasRuntimeAuthority(instanceId: string, generation: number, signal: AbortSignal): boolean {
    return !this.stopped && !signal.aborted && (this.instanceGeneration.get(instanceId) ?? 0) === generation
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

function queuedEventKey(event: InstanceStreamPayload): string | undefined {
  if (SESSION_UPSERT_TYPES.has(event.type ?? "") || SESSION_REMOVE_TYPES.has(event.type ?? "")) {
    const info = (event.properties as { info?: SessionProperties } | undefined)?.info
    const sessionId = readString(info?.id) ?? readString(event.properties?.id)
    return sessionId ? `session:${sessionId}` : undefined
  }
  if (PERMISSION_ASK_TYPES.has(event.type ?? "") || PERMISSION_REPLIED_TYPES.has(event.type ?? "")) {
    const properties = event.properties as PermissionRepliedProperties | undefined
    const permissionId =
      readString(properties?.id) ??
      readString(properties?.requestID) ??
      readString(properties?.permissionID) ??
      readString(properties?.requestId) ??
      readString(properties?.permissionId)
    return permissionId ? `permission:${permissionId}` : undefined
  }
  return undefined
}

function isSessionEvent(event: InstanceStreamPayload): boolean {
  return SESSION_UPSERT_TYPES.has(event.type ?? "") || SESSION_REMOVE_TYPES.has(event.type ?? "")
}
