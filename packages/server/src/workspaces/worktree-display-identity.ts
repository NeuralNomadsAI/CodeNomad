import type { WorkspaceManager } from "./manager"
import type { WorktreeDeletionFence } from "./worktree-session-evacuation"

/** Deletion blocks Git worktree identities (`wsl:<distro>:/path` under WSL), not
 * daemon service paths, so a display read must also capture the identities of
 * its service directories. The synchronous path capture taken at call time keeps
 * the delete-and-unblock ABA fence across the asynchronous resolution; an
 * unresolved directory keeps only that path capture. */
export async function captureDisplayIdentities(fence: WorktreeDeletionFence | undefined,
  manager: Pick<WorkspaceManager, "getWorktreeIdentityForPath">, workspaceID: string,
  directories: readonly string[]): Promise<(() => boolean) | undefined> {
  if (!fence) return undefined
  const paths = fence.captureDisplay(directories)
  const identities = await Promise.all([...new Set(directories)].map(directory =>
    manager.getWorktreeIdentityForPath(workspaceID, directory).catch(() => undefined)))
  const resolved = fence.captureDisplay(identities.filter((identity): identity is string => !!identity))
  return () => paths() && resolved()
}
