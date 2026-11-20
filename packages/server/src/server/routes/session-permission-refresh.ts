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
  "get" | "getServiceWslDistro" | "getWorktreeIdentityForPath" | "ownsLocation">
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
  const schedule = (instanceId: string, connection: ServiceConnection, target: Target) => {
    if (!ordinaryPermissionSession(target.id)) return
    const workspace = manager.get(instanceId)
    if (!workspace) return
    const { client } = connection
    const distro = manager.getServiceWslDistro(instanceId)
    queued.set(JSON.stringify([instanceId, target.id]), async () => {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)])
      const current = () => {
        signal.throwIfAborted()
        connection.assertCurrent()
        if (manager.get(instanceId) !== workspace) throw new SessionModeConflict("Workspace changed")
      }
      let releaseWorktree: (() => void) | undefined
      let releaseSession: (() => void) | undefined
      try {
        current()
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
      } catch (error) {
        if (!(isSessionNotFoundError(error) && error.sessionID === target.id) && !lifetime.signal.aborted) {
          logger.warn({ instanceId }, "Unable to refresh conversation permissions")
        }
      } finally {
        releaseSession?.()
        releaseWorktree?.()
      }
    })
    drain()
  }
  const onEvent = ({ instanceId, event }: InstanceEvent) => {
    const connection = nativeEventConnections.get(event)
    if (!connection) return
    const distro = manager.getServiceWslDistro(instanceId)
    if (event.type === "config.updated") {
      let location
      try { location = event.location === undefined ? undefined : readLocationRef(event.location) }
      catch { return }
      for (const target of modes.knownAt(distro, location?.directory)) schedule(instanceId, connection, target)
    } else if (event.type === "session.created" && event.data.parentID && event.data.permissions?.length) {
      schedule(instanceId, connection, { id: event.data.sessionID })
    } else if (event.type === "session.forked") {
      schedule(instanceId, connection, { id: event.data.sessionID })
    } else if (event.type === "session.moved" && modes.knownAt(distro).some(target => target.id === event.data.sessionID)) {
      schedule(instanceId, connection, { id: event.data.sessionID })
    } else if (event.type === "session.deleted") {
      modes.forgetDeleted(distro, event.data.sessionID)
    }
  }
  const onStatus = ({ instanceId, status }: Extract<WorkspaceEventPayload, { type: "instance.eventStatus" }>) => {
    if (status !== "connected") return
    const connection = manager.getExistingSharedServiceConnection?.(instanceId)
    if (!connection) return
    for (const target of modes.knownAt(manager.getServiceWslDistro(instanceId))) schedule(instanceId, connection, target)
  }
  bus.on("instance.event", onEvent)
  bus.on("instance.eventStatus", onStatus)
  return () => {
    bus.off("instance.event", onEvent)
    bus.off("instance.eventStatus", onStatus)
    queued.clear()
    lifetime.abort()
    return task
  }
}
