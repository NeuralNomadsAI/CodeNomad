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

/** The members of complete families with a member in the opened folder or a
 * registered worktree, including a parent needed by a local descendant, plus
 * the families of `include` (sessions shown explicitly). */
export function selectWorkspaceFamilyIds(
  members: Iterable<{ id: string; parentId?: string | null; directory?: string }>,
  folder: string,
  worktrees: WorktreeDescriptor[],
  include: Iterable<string> = [],
): Set<string> {
  const directories = workspaceSessionDirectories(folder, worktrees)
  const byId = new Map([...members].map((member) => [member.id, member]))
  const rootOf = (id: string): string => {
    const seen = new Set<string>()
    let member = byId.get(id)!
    while (member.parentId && byId.has(member.parentId) && !seen.has(member.id)) {
      seen.add(member.id)
      member = byId.get(member.parentId)!
    }
    return member.id
  }
  const roots = new Set([...byId.values()]
    .filter((member) => member.directory && directories.has(normalizeSessionDirectory(member.directory)))
    .map((member) => rootOf(member.id)))
  for (const id of include) if (byId.has(id)) roots.add(rootOf(id))
  return new Set([...byId.keys()].filter((id) => roots.has(rootOf(id))))
}

export function selectWorkspaceSessionFamilies(
  inventory: SessionInfo[],
  folder: string,
  worktrees: WorktreeDescriptor[],
): SessionInfo[] {
  const ids = selectWorkspaceFamilyIds(inventory.map((session) => ({ id: session.id, parentId: session.parentID,
    directory: session.location.directory })), folder, worktrees)
  return inventory.filter((session) => ids.has(session.id))
}
