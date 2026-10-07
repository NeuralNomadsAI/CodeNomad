import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { OwnedAuthorityMutationGate } from "../host-authority/qualification"
import { observeAuthorityRead } from "../host-authority/qualification"
import { rejectAuthority, type AuthorityBinding } from "../authority-protocol"
import { assertSynchronousAuthorityGuard } from "../authority-synchronous"
import type { CanonicalMissionRoots } from "./roots"
import type { ServiceConnection } from "../../workspaces/opencode-service"

type Manager = Pick<WorkspaceManager, "getSharedServiceConnection" | "getExistingSharedServiceConnection" | "ownsLocation" | "getWorktreeIdentityForPath">
export function canonicalAuthorityOwnership(input: {
  manager: Manager; workspaceID: string; fence: WorktreeDeletionFence; roots: CanonicalMissionRoots; assertNativeCurrent(): true
}): OwnedAuthorityMutationGate {
  const admit = async <T>(binding: AuthorityBinding, operation: (current: () => true) => Promise<T>,
    connection: ServiceConnection | undefined, checkRoots: () => Promise<void>, purpose: "request" | "event", signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted()
    if (!connection) rejectAuthority("observation-unavailable")
    // Existing selected coordinator only. Unproven creation of new managed actors
    // is rejected rather than guessing generated session ownership.
    const coordinator = await connection.client.session.get({ sessionID: binding.coordinatorSessionID }, { signal })
    if (coordinator.id !== binding.coordinatorSessionID || coordinator.parentID || coordinator.projectID !== binding.projectID
      || !binding.roots.some(root => root.directory === coordinator.location.directory)
      || !await input.manager.ownsLocation(input.workspaceID, coordinator.location, connection.client, signal, purpose)) rejectAuthority("binding-mismatch")
    const observe = <R>(pending: Promise<R>) => purpose === "event" ? observeAuthorityRead(pending, signal) : pending
    await observe(checkRoots())
    const identities = await observe(Promise.all(binding.roots.map(root => input.manager.getWorktreeIdentityForPath(input.workspaceID, root.directory, purpose))))
    if (identities.some(value => !value)) rejectAuthority("observation-unavailable")
    signal.throwIfAborted()
    const release = input.fence.enter(identities as string[])
    if (!release) rejectAuthority("authorization-blocked")
    const current = (): true => {
      signal.throwIfAborted()
      connection.assertCurrent()
      assertSynchronousAuthorityGuard(input.assertNativeCurrent, "policy-unqualified")
      input.roots.current(binding.roots)
      return true
    }
    try { current(); return await operation(current) }
    finally { release() }
  }
  return {
    async withOwned(binding, operation, signal = AbortSignal.timeout(15_000)) {
      signal.throwIfAborted()
      // Acquisition can start/provision the shared service. Never abandon this
      // effect-bearing preparation as if it were an existing-only read.
      const connection = await input.manager.getSharedServiceConnection(input.workspaceID)
      return admit(binding, operation, connection, () => input.roots.assertRoots(binding.roots), "request", signal)
    },
    async withExisting(binding, operation, signal) {
      signal.throwIfAborted()
      const connection = input.manager.getExistingSharedServiceConnection(input.workspaceID)
      return admit(binding, operation, connection, () => input.roots.assertExistingRoots(binding.roots, signal), "event", signal)
    },
  }
}
