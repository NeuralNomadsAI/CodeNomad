import { z } from "zod"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { removeCleanupTarget, type MissionCleanupTarget } from "../../missions/native-session-cleanup"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { MissionCleanupReason } from "../../missions/model"

const schema = z.object({
  kind: z.literal("cleanup"), input: z.object({
    missionID: z.string().min(1).max(100), deletionID: z.string().min(1).max(100),
    sessionID: z.string().regex(/^ses_/).max(240),
  }).strict(),
}).strict()
type Manager = Pick<WorkspaceManager, "list" | "getSharedServiceConnection" | "ownsLocation" | "getWorktreeIdentityForPath">

// Invoked only by the authenticated mission bridge, never by a generic RPC proxy.
export async function cleanupMissionSession(manager: Manager, fence: WorktreeDeletionFence, coordinatorID: string, command: unknown, signal: AbortSignal) {
  const { input } = schema.parse(command)
  signal.throwIfAborted()
  const owner = await Promise.any(manager.list().map(async workspace => {
    const connection = await manager.getSharedServiceConnection(workspace.id)
    if (!connection) throw new Error("Workspace unavailable")
    const coordinator = await connection.client.session.get({ sessionID: coordinatorID }, { signal })
    if (coordinator.id !== coordinatorID || coordinator.parentID
      || !await manager.ownsLocation(workspace.id, coordinator.location, connection.client, signal)) throw new Error("Foreign coordinator")
    signal.throwIfAborted(); connection.assertCurrent()
    return { workspace, connection, coordinator }
  })).catch(() => undefined)
  if (!owner) throw new Error("Missing mission owner")
  const { workspace, connection, coordinator } = owner
  const client = connection.client
  const options = { location: { directory: coordinator.location.directory }, ...locationRequestOptions(coordinator.location), signal }
  const authority = await client.rpc(CODENOMAD_MISSIONS_RPC).cleanupTarget(input, options) as { target?: MissionCleanupTarget }
  const target = authority.target
  if (!target) return { outcome: "retained" as const }
  if (target.sessionID !== input.sessionID || target.missionID !== input.missionID || target.coordinatorSessionID !== coordinatorID
    || target.sessionID === coordinatorID || target.projectID !== coordinator.projectID
    || !await manager.ownsLocation(workspace.id, target.location, client, signal)) throw new Error("Foreign cleanup target")
  const identities = await Promise.all([coordinator.location, target.location].map(location => manager.getWorktreeIdentityForPath(workspace.id, location.directory)))
  if (identities.some(identity => !identity)) throw new Error("Missing mission worktree")
  const release = fence.enter(identities as string[])
  if (!release) throw new Error("Worktree mutation in progress")
  try {
    const assertCurrent = () => { signal.throwIfAborted(); connection.assertCurrent() }
    const validateAdmission = async () => {
      assertCurrent()
      const currentCoordinator = await client.session.get({ sessionID: coordinatorID }, { signal })
      if (currentCoordinator.id !== coordinatorID || currentCoordinator.parentID || currentCoordinator.projectID !== coordinator.projectID
        || !sameLocation(currentCoordinator.location, coordinator.location)) throw new Error("Coordinator moved")
      const owned = await Promise.all([coordinator.location, target.location].map(location =>
        manager.ownsLocation(workspace.id, location, client, signal)))
      // A shared daemon can remain current after this workspace loses ownership.
      // Validate both ORIGINAL admitted locations, never adopt a replacement.
      assertCurrent()
      if (owned.some(value => value !== true)) throw new Error("Mission cleanup ownership changed")
    }
    await validateAdmission()
    let reason: MissionCleanupReason | undefined
    const outcome = await removeCleanupTarget({
      get: input => client.session.get(input, { signal }),
      list: input => client.session.list(input, { signal }),
      remove: input => { assertCurrent(); return client.session.remove(input, { signal }) },
    }, target, () => { assertCurrent(); return true }, value => { reason = value }, validateAdmission)
    return { outcome, ...(reason ? { reason } : {}) }
  } finally { release() }
}
