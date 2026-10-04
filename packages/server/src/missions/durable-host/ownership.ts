import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { OwnedAuthorityMutationGate } from "../host-authority/qualification"
import { rejectAuthority } from "../authority-protocol"
import { assertSynchronousAuthorityGuard } from "../authority-synchronous"
import type { CanonicalMissionRoots } from "./roots"

type Manager = Pick<WorkspaceManager, "getSharedServiceConnection" | "ownsLocation" | "getWorktreeIdentityForPath">
export function canonicalAuthorityOwnership(input: {
  manager: Manager; workspaceID: string; fence: WorktreeDeletionFence; roots: CanonicalMissionRoots; assertNativeCurrent(): true
}): OwnedAuthorityMutationGate {
  return { async withOwned(binding, operation) {
    const connection = await input.manager.getSharedServiceConnection(input.workspaceID)
    if (!connection) rejectAuthority("observation-unavailable")
    // Existing selected coordinator only. Unproven creation of new managed actors
    // is rejected rather than guessing generated session ownership.
    const coordinator = await connection.client.session.get({ sessionID: binding.coordinatorSessionID })
    if (coordinator.parentID || coordinator.projectID !== binding.projectID
      || !binding.roots.some(root => root.directory === coordinator.location.directory)
      || !await input.manager.ownsLocation(input.workspaceID, coordinator.location, connection.client)) rejectAuthority("binding-mismatch")
    await input.roots.assertRoots(binding.roots)
    const identities = await Promise.all(binding.roots.map(root => input.manager.getWorktreeIdentityForPath(input.workspaceID, root.directory)))
    if (identities.some(value => !value)) rejectAuthority("observation-unavailable")
    const release = input.fence.enter(identities as string[])
    if (!release) rejectAuthority("authorization-blocked")
    const current = (): true => {
      connection.assertCurrent()
      assertSynchronousAuthorityGuard(input.assertNativeCurrent, "policy-unqualified")
      input.roots.current(binding.roots)
      return true
    }
    try { current(); return await operation(current) }
    finally { release() }
  } }
}
