import type { LocationRef } from "@opencode/client"
import { sameLocation } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { MissionControlError } from "../../missions/control-error"
import { holdMissionCreation, type MissionCreationOperation } from "./mission-creation-holds"

export type MissionCreationManager = Pick<WorkspaceManager, "get" | "ownsLocation" | "getServiceDirectoryForPath" | "getWorktreeIdentityForPath">

/** Keep the physical checkout admission until the caller's native creation AND
 * publication/contract settlement have finished. Never race a mutation against
 * request cancellation and release its admission while the native write runs. */
export async function admitMissionCreationLocations(manager: MissionCreationManager, fence: WorktreeDeletionFence,
  workspaceID: string, connection: ServiceConnection, locations: readonly LocationRef[], signal: AbortSignal,
  operation?: MissionCreationOperation) {
  const resolve = async (location: LocationRef) => {
    if (!manager.get(workspaceID) || !await manager.ownsLocation(workspaceID, location, connection.client, signal)) {
      throw new MissionControlError("Mission creation location is not owned", "foreign-session")
    }
    const directory = await manager.getServiceDirectoryForPath(workspaceID, location.directory)
    const identity = await manager.getWorktreeIdentityForPath(workspaceID, location.directory)
    if (!directory || !identity) throw new MissionControlError("Mission creation location is unavailable", "foreign-session")
    signal.throwIfAborted(); connection.assertCurrent()
    return { location: { directory }, identity }
  }
  const admitted = await Promise.all(locations.map(resolve))
  const enter = () => fence.enter(admitted.map(item => item.identity))
  const hold = operation ? holdMissionCreation(fence, { ...operation, connection,
    locations: admitted.map(item => ({ directory: item.location.directory, identity: item.identity })) }, enter) : undefined
  const release = operation ? hold && (() => hold.release()) : enter()
  if (!release) throw new MissionControlError("Worktree deletion is in progress", "worktree-deleting")
  const assertCurrent = async () => {
    const current = await Promise.all(locations.map(resolve))
    if (current.some((item, index) => item.identity !== admitted[index].identity
      || !sameLocation(item.location, admitted[index].location))) {
      throw new MissionControlError("Mission creation location changed", "foreign-session")
    }
    signal.throwIfAborted(); connection.assertCurrent()
  }
  try { await assertCurrent() }
  catch (error) { release(); throw error }
  return { release, assertCurrent, dispatched: () => hold?.dispatched(), settled: () => hold?.settled(),
    get uncertain() { return hold?.uncertain ?? false } }
}
