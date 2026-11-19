import type { WorktreeDescriptor } from "../../../server/src/api-types"
import { normalizeSessionDirectory } from "./session-list-options"

const isWithin = (root: string, target: string) => target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`)

/**
 * Whether the workspace proxy serves a session located in this directory,
 * mirroring the server's selection (`WorkspaceManager.ownsDirectory`,
 * `resolveOwnedWorktreePath`) over the same registered inventory: the opened
 * folder and every directory within a registered checkout directory (WSL
 * service paths too), while an exact-folder (`directoryOnly`) entry owns only
 * itself. It decides only whether a moved session is located elsewhere; list
 * membership keeps `selectWorkspaceFamilyIds`.
 */
export function isWorkspaceServedDirectory(directory: string, folder: string, worktrees: WorktreeDescriptor[]): boolean {
  const target = normalizeSessionDirectory(directory)
  if (!target) return false
  if (target === normalizeSessionDirectory(folder)) return true
  return worktrees.some((worktree) => [worktree.directory, worktree.serviceDirectory].some((candidate) => {
    const root = normalizeSessionDirectory(candidate)
    return Boolean(root) && (worktree.directoryOnly ? target === root : isWithin(root, target))
  }))
}
