import type { SessionInfo } from "@opencode/client"
import type { WorktreeDescriptor } from "../../../server/src/api-types"
import { normalizeSessionDirectory } from "./session-list-options"

const isWithin = (root: string, target: string) => target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`)

/**
 * Whether the workspace proxy serves a session in this directory, mirroring the
 * server's selection (`WorkspaceManager.ownsDirectory`, `resolveOwnedWorktreePath`
 * in `workspaces/worktree-directory.ts`) over the same registered inventory: the
 * opened folder, and every directory within a registered checkout directory (the
 * root entry included, WSL service paths too), except that an exact-folder
 * (`directoryOnly`) entry owns only itself. Native project IDs, shared by
 * independent clones, never grant ownership. The server additionally checks
 * physical path and Git identity, which this display mirror cannot read.
 */
export function isWorkspaceSessionDirectory(directory: string, folder: string, worktrees: WorktreeDescriptor[]): boolean {
  const target = normalizeSessionDirectory(directory)
  if (!target) return false
  if (target === normalizeSessionDirectory(folder)) return true
  return worktrees.some((worktree) => [worktree.directory, worktree.serviceDirectory].some((candidate) => {
    const root = normalizeSessionDirectory(candidate)
    return Boolean(root) && (worktree.directoryOnly ? target === root : isWithin(root, target))
  }))
}

/** The members the workspace proxy serves (`isWorkspaceSessionDirectory`): a
 * session elsewhere never belongs to the workspace, whatever its family. Only
 * the complete families of `include` (sessions shown explicitly) are added. */
export function selectWorkspaceFamilyIds(
  members: Iterable<{ id: string; parentId?: string | null; directory?: string }>,
  folder: string,
  worktrees: WorktreeDescriptor[],
  include: Iterable<string> = [],
): Set<string> {
  const byId = new Map([...members].map((member) => [member.id, member]))
  const ids = new Set([...byId.values()]
    .filter((member) => member.directory && isWorkspaceSessionDirectory(member.directory, folder, worktrees))
    .map((member) => member.id))
  const explicit = [...include].filter((id) => byId.has(id))
  if (!explicit.length) return ids
  const rootOf = (id: string): string => {
    const seen = new Set<string>()
    let member = byId.get(id)!
    while (member.parentId && byId.has(member.parentId) && !seen.has(member.id)) {
      seen.add(member.id)
      member = byId.get(member.parentId)!
    }
    return member.id
  }
  const roots = new Set(explicit.map(rootOf))
  for (const id of byId.keys()) if (roots.has(rootOf(id))) ids.add(id)
  return ids
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
