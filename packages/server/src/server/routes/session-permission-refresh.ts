import { isSessionNotFoundError } from "@opencode/client"
import type { WorkspaceEventPayload } from "../../api-types"
import type { EventBus } from "../../events/bus"
import type { Logger } from "../../logger"
import { readLocationRef, sameLocation } from "../../opencode/compatibility/location"
import { isPermissionRoot, SessionModeConflict, type SessionPermissionModes } from "../../permissions/session-mode"
import { sessionPermissionRules } from "../../permissions/session-mode-rules"
import type { WorkspaceManager } from "../../workspaces/manager"
import { nativeEventConnections, type ServiceConnection } from "../../workspaces/opencode-service"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { SessionCleanupFence } from "../session-cleanup-fence"
import { ordinaryPermissionSession, sessionPermissionTarget } from "./session-permission-mode"

type InstanceEvent = Extract<WorkspaceEventPayload, { type: "instance.event" }>
type Target = { id: string; created?: number; directory?: string }

export function connectSessionPermissionRefresh(bus: EventBus, manager: Pick<WorkspaceManager,
  "get" | "getServiceDirectory" | "getServiceWslDistro" | "getWorktreeIdentityForPath" | "ownsLocation">
  & Partial<Pick<WorkspaceManager, "getExistingSharedServiceConnection">>,
  modes: SessionPermissionModes, worktrees: WorktreeDeletionFence, cleanup: SessionCleanupFence, logger: Logger) {
  const lifetime = new AbortController()
  const queued = new Map<string, () => Promise<void>>()
  const observations = new Set<Promise<unknown>>()
  const scope = (instanceId: string, connection: ServiceConnection) => {
    const workspace = manager.get(instanceId)
    if (!workspace || lifetime.signal.aborted) return
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)])
    const current = () => {
      signal.throwIfAborted()
      connection.assertCurrent()
      if (manager.get(instanceId) !== workspace) throw new SessionModeConflict("Workspace changed")
    }
    return { signal, current, distro: manager.getServiceWslDistro(instanceId) }
  }
  const missing = async (connection: ServiceConnection, sessionID: string, { signal, current }: NonNullable<ReturnType<typeof scope>>, created?: number) => {
    current()
    try {
      const session = await connection.client.session.get({ sessionID }, { signal })
      current()
      return created !== undefined && session.id === sessionID && session.time.created !== created
    } catch (error) {
      current()
      if (isSessionNotFoundError(error) && error.sessionID === sessionID) return true
      throw error
    }
  }
  let task: Promise<void> | undefined
  const drain = () => {
    if (task) return
    task = Promise.resolve().then(async () => {
      for (const [key, refresh] of queued) {
        queued.delete(key)
        await refresh()
      }
    }).finally(() => { task = undefined; if (queued.size) drain() })
  }
  const enqueue = (instanceId: string, connection: ServiceConnection, key: string[], refresh: (
    context: { signal: AbortSignal; current(): void; distro: string | undefined }) => Promise<void>, missingID?: string) => {
    const workspace = manager.get(instanceId)
    if (!workspace) return
    queued.set(JSON.stringify([instanceId, ...key]), async () => {
      if (manager.get(instanceId) !== workspace) return
      const context = scope(instanceId, connection)
      if (!context) return
      try {
        context.current()
        await refresh(context)
      } catch (error) {
        if (!(missingID && isSessionNotFoundError(error) && error.sessionID === missingID) && !lifetime.signal.aborted) {
          logger.warn({ instanceId }, "Unable to refresh conversation permissions")
        }
      }
    })
    drain()
  }
  const schedule = (instanceId: string, connection: ServiceConnection, target: Target) => {
    if (!ordinaryPermissionSession(target.id)) return
    const { client } = connection
    enqueue(instanceId, connection, ["session", target.id, String(target.created ?? ""), target.directory ?? ""], async ({ signal, current, distro }) => {
      let releaseWorktree: (() => void) | undefined
      let releaseSession: (() => void) | undefined
      const context = { signal, current, distro }
      const forgetMissing = () => target.created !== undefined
        ? modes.forgetDeleted(distro, target.id, () => missing(connection, target.id, context, target.created), target.created)
        : undefined
      try {
        const session = await client.session.get({ sessionID: target.id }, { signal })
        const owns = (location: typeof session.location) => manager.ownsLocation(instanceId, location, client, { signal })
        if (session.id !== target.id) return
        if (target.created !== undefined && session.time.created !== target.created) { await forgetMissing(); return }
        if ((target.directory && session.location.directory !== target.directory) || !await owns(session.location)) return
        current()
        if (!modes.mayBeSupervised(session)) return
        const identity = await manager.getWorktreeIdentityForPath(instanceId, session.location.directory)
        current()
        if (!identity) return
        releaseWorktree = worktrees.enter([identity])
        releaseSession = cleanup.enterMutation(session.id)
        if (!releaseWorktree || !releaseSession) return
        await modes.refresh(sessionPermissionTarget(session, { client, current, signal, distro }))
      } catch (error) {
        if (!(isSessionNotFoundError(error) && error.sessionID === target.id)) throw error
        await forgetMissing()
      } finally {
        releaseSession?.()
        releaseWorktree?.()
      }
    }, target.id)
  }
  const scheduleLocation = (instanceId: string, connection: ServiceConnection, directory?: string) => {
    // Read saved targets at dispatch, so a trailing invalidation also sees intervening writes.
    enqueue(instanceId, connection, ["location", directory ?? ""], async ({ distro }) => {
      const { targets, legacy } = modes.refreshTargets(distro, directory)
      for (const target of targets) schedule(instanceId, connection, { id: target.id, created: target.created, directory })
      if (!legacy.size) return
      // Hash-only records can only be recovered from native session metadata.
      enqueue(instanceId, connection, ["legacy", directory ?? ""], async ({ signal, current }) => {
        const { client } = connection
        const root = directory ?? manager.getServiceDirectory(instanceId)
        if (!root || !await manager.ownsLocation(instanceId, { directory: root }, client, { signal })) return
        current()
        const { project } = await client.location.get({ location: { directory: root } }, { signal })
        const scope = directory ?? (project.id === "global" ? root : undefined)
        const cursors = new Set<string>()
        let cursor: string | undefined
        do {
          current()
          const page = await client.session.list(cursor ? { cursor }
            : { project: project.id, ...(scope && { directory: scope }), limit: 100 }, { signal })
          current()
          for (const session of page.data) {
            if (session.projectID === project.id && (!scope || session.location.directory === scope)
              && modes.matchLegacyTarget(distro, session, legacy)) {
              schedule(instanceId, connection, { id: session.id, created: session.time.created, directory: scope })
            }
          }
          cursor = page.cursor.next ?? undefined
          if (cursor && cursors.has(cursor)) throw new Error("Repeated session cursor")
          if (cursor) cursors.add(cursor)
        } while (cursor && legacy.size)
      })
    })
  }
  const observe = (instanceId: string, connection: ServiceConnection,
    event: Extract<InstanceEvent["event"], { type: "session.created" | "session.forked" }>) => {
    const { client } = connection
    const { sessionID, parentID } = event.data
    if (!parentID || !ordinaryPermissionSession(sessionID) || !ordinaryPermissionSession(parentID)) return
    if (event.type === "session.created" && !modes.mayBeSupervised(event.data)) return
    const context = scope(instanceId, connection)
    if (!context) return
    const { current, distro, signal } = context
    const observation = modes.observeCopy(distro, sessionID, parentID, async () => {
      current()
      const session = await client.session.get({ sessionID }, { signal })
      const owns = (location: typeof session.location) => manager.ownsLocation(instanceId, location, client, { signal })
      if (session.id !== sessionID || session.time.created !== event.created) return
      let permissions
      if (event.type === "session.created") {
        if (isPermissionRoot(session) || session.parentID !== parentID || session.projectID !== event.data.projectID
          || !sameLocation(session.location, event.data.location)) return
        permissions = event.data.permissions
      } else {
        // A fork copies its source, and importing its history also updates its timestamp.
        if (session.fork?.sessionID !== parentID || !modes.mayBeSupervised(session)) return
        permissions = session.permissions
      }
      const source = await client.session.get({ sessionID: parentID }, { signal })
      if (source.id !== parentID || source.projectID !== session.projectID
        || !await owns(session.location) || !await owns(source.location)) return
      current()
      const fresh = await sessionPermissionTarget(session, { client, ...context }).read()
      return { session: fresh, source, current, rules: sessionPermissionRules.parse(permissions ?? []) }
    }).then(recorded => {
      if (recorded && !lifetime.signal.aborted) schedule(instanceId, connection, { id: sessionID, created: event.created })
    }).catch(error => {
      if (!(isSessionNotFoundError(error) && error.sessionID === sessionID) && !lifetime.signal.aborted) {
        logger.warn({ instanceId }, "Unable to record copied conversation permissions")
      }
    }).finally(() => observations.delete(observation))
    observations.add(observation)
  }
  const onEvent = ({ instanceId, event }: InstanceEvent) => {
    const connection = nativeEventConnections.get(event)
    if (!connection) return
    if (event.type === "config.updated") {
      let location
      try { location = event.location === undefined ? undefined : readLocationRef(event.location) }
      catch { return }
      scheduleLocation(instanceId, connection, location?.directory)
    } else if (event.type === "session.created" || event.type === "session.forked") {
      observe(instanceId, connection, event)
    } else if (event.type === "session.moved" || event.type === "session.permissions") {
      schedule(instanceId, connection, { id: event.data.sessionID })
    } else if (event.type === "session.deleted" && ordinaryPermissionSession(event.data.sessionID)) {
      const { sessionID } = event.data
      enqueue(instanceId, connection, ["deleted", sessionID], async context => {
        await modes.forgetDeleted(context.distro, sessionID, () => missing(connection, sessionID, context))
      })
    }
  }
  const onStatus = ({ instanceId, status }: Extract<WorkspaceEventPayload, { type: "instance.eventStatus" }>) => {
    if (status !== "connected") return
    const connection = manager.getExistingSharedServiceConnection?.(instanceId)
    if (!connection) return
    scheduleLocation(instanceId, connection)
  }
  const unsubscribe = bus.onEvent(event => {
    if (event.type === "instance.event") onEvent(event)
    else if (event.type === "instance.eventStatus") onStatus(event)
  })
  return () => {
    unsubscribe()
    queued.clear()
    lifetime.abort()
    return Promise.allSettled([task, ...observations])
  }
}
