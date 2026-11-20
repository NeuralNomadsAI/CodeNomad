import { isSessionNotFoundError } from "@opencode/client"
import type { WorkspaceEventPayload } from "../../api-types"
import type { EventBus } from "../../events/bus"
import type { Logger } from "../../logger"
import { readLocationRef } from "../../opencode/compatibility/location"
import { SessionModeConflict, type SessionPermissionModes } from "../../permissions/session-mode"
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
    const distro = manager.getServiceWslDistro(instanceId)
    queued.set(JSON.stringify([instanceId, ...key]), async () => {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)])
      const current = () => {
        signal.throwIfAborted()
        connection.assertCurrent()
        if (manager.get(instanceId) !== workspace) throw new SessionModeConflict("Workspace changed")
      }
      try {
        current()
        await refresh({ signal, current, distro })
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
      try {
        const session = await client.session.get({ sessionID: target.id }, { signal })
        const owns = (location: typeof session.location) => manager.ownsLocation(instanceId, location, client, { signal })
        if (session.id !== target.id || (target.created !== undefined && session.time.created !== target.created)
          || (target.directory && session.location.directory !== target.directory) || !await owns(session.location)) return
        current()
        if (!modes.mayBeSupervised(session)) return
        const identity = await manager.getWorktreeIdentityForPath(instanceId, session.location.directory)
        current()
        if (!identity) return
        releaseWorktree = worktrees.enter([identity])
        releaseSession = cleanup.enterMutation(session.id)
        if (!releaseWorktree || !releaseSession) return
        await modes.refresh(sessionPermissionTarget(session, { client, current, signal, distro }, owns))
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
  const onEvent = ({ instanceId, event }: InstanceEvent) => {
    const connection = nativeEventConnections.get(event)
    if (!connection) return
    const distro = manager.getServiceWslDistro(instanceId)
    if (event.type === "config.updated") {
      let location
      try { location = event.location === undefined ? undefined : readLocationRef(event.location) }
      catch { return }
      scheduleLocation(instanceId, connection, location?.directory)
    } else if (event.type === "session.created" && event.data.parentID && event.data.permissions?.length) {
      schedule(instanceId, connection, { id: event.data.sessionID })
    } else if (event.type === "session.forked" || event.type === "session.moved" || event.type === "session.permissions") {
      schedule(instanceId, connection, { id: event.data.sessionID })
    } else if (event.type === "session.deleted") {
      modes.forgetDeleted(distro, event.data.sessionID)
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
    return task
  }
}
