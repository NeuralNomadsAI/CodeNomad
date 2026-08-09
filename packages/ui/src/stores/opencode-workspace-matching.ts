import type { WorktreeDescriptor } from "../../../server/src/api-types"

type OpenCodeWorkspaceLike = {
  id: string
  directory?: string | null
}

function normalizeWorkspaceDirectory(directory: string | null | undefined): string {
  const trimmed = (directory ?? "").trim()
  if (!trimmed) return ""
  const normalized = trimmed.replace(/\\+/g, "/").replace(/\/+$/g, "")
  if (/^[\\/]{2}/.test(trimmed) && !normalized.startsWith("//")) {
    return `/${normalized}`
  }
  return normalized
}

function isWindowsWorkspaceDirectory(directory: string): boolean {
  return /^[A-Za-z]:\//.test(directory) || directory.startsWith("//")
}

function normalizeWindowsWorkspaceDirectory(directory: string): string {
  return normalizeWorkspaceDirectory(directory).toLowerCase()
}

function workspaceDirectoriesEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeWorkspaceDirectory(left)
  const normalizedRight = normalizeWorkspaceDirectory(right)
  if (normalizedLeft === normalizedRight) return true
  return isWindowsWorkspaceDirectory(normalizedLeft)
    && isWindowsWorkspaceDirectory(normalizedRight)
    && normalizeWindowsWorkspaceDirectory(normalizedLeft) === normalizeWindowsWorkspaceDirectory(normalizedRight)
}

function findWorktreeSlugForDirectory(
  worktrees: Pick<WorktreeDescriptor, "slug" | "directory">[],
  target: string | null | undefined,
): string | null {
  const directory = normalizeWorkspaceDirectory(target)
  if (!directory) return null
  const windowsDirectory = isWindowsWorkspaceDirectory(directory) ? normalizeWindowsWorkspaceDirectory(directory) : null
  return worktrees.find((worktree) => {
    const candidate = normalizeWorkspaceDirectory(worktree.directory)
    if (candidate === directory) return true
    return windowsDirectory !== null
      && isWindowsWorkspaceDirectory(candidate)
      && normalizeWindowsWorkspaceDirectory(candidate) === windowsDirectory
  })?.slug ?? null
}

function mapOpenCodeWorkspacesToWorktreeSlugs(
  worktrees: Pick<WorktreeDescriptor, "slug" | "directory">[],
  workspaces: OpenCodeWorkspaceLike[],
): Map<string, string> {
  const byDirectory = new Map<string, OpenCodeWorkspaceLike>()
  const byWindowsDirectory = new Map<string, OpenCodeWorkspaceLike>()
  for (const workspace of workspaces) {
    const directory = normalizeWorkspaceDirectory(workspace.directory)
    if (!directory) continue
    byDirectory.set(directory, workspace)
    if (isWindowsWorkspaceDirectory(directory)) {
      byWindowsDirectory.set(normalizeWindowsWorkspaceDirectory(directory), workspace)
    }
  }

  const next = new Map<string, string>()
  for (const worktree of worktrees) {
    if (worktree.slug === "root") continue
    const directory = normalizeWorkspaceDirectory(worktree.directory)
    const workspace = byDirectory.get(directory) ?? (isWindowsWorkspaceDirectory(directory) ? byWindowsDirectory.get(normalizeWindowsWorkspaceDirectory(directory)) : undefined)
    if (workspace?.id) next.set(worktree.slug, workspace.id)
  }
  return next
}

export { findWorktreeSlugForDirectory, mapOpenCodeWorkspacesToWorktreeSlugs, workspaceDirectoriesEqual }
