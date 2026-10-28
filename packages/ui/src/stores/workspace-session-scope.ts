import type { SessionInfo } from "@opencode/client"
import type { WorktreeDescriptor } from "../../../server/src/api-types"
import { normalizeSessionDirectory } from "./session-list-options"

// Native project IDs may be shared by independent clones. The opened local
// directory and its registered worktrees define the CodeNomad workspace.
function workspaceSessionDirectories(folder: string, worktrees: WorktreeDescriptor[]): Set<string> {
  return new Set([folder, ...worktrees.flatMap((worktree) => [
    worktree.directory,
    worktree.serviceDirectory ?? worktree.directory,
  ])].map(normalizeSessionDirectory).filter(Boolean))
}

/** Whether a session in this directory belongs to the workspace's session list. */
export function isWorkspaceSessionDirectory(directory: string, folder: string, worktrees: WorktreeDescriptor[]): boolean {
  return workspaceSessionDirectories(folder, worktrees).has(normalizeSessionDirectory(directory))
}

export function selectWorkspaceSessionFamilies(
  inventory: SessionInfo[],
  folder: string,
  worktrees: WorktreeDescriptor[],
): SessionInfo[] {
  const directories = workspaceSessionDirectories(folder, worktrees)
  const byId = new Map(inventory.map((session) => [session.id, session]))
  const rootOf = (session: SessionInfo): string => {
    const seen = new Set<string>()
    while (session.parentID && byId.has(session.parentID) && !seen.has(session.id)) {
      seen.add(session.id)
      session = byId.get(session.parentID)!
    }
    return session.id
  }
  // Keep complete families, including a parent needed by a local descendant.
  const roots = new Set(inventory
    .filter((session) => directories.has(normalizeSessionDirectory(session.location.directory)))
    .map(rootOf))
  return inventory.filter((session) => roots.has(rootOf(session)))
}
