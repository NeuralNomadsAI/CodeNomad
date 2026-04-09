import type { LogLike } from "./git-worktrees"
import { listWorktrees, resolveRepoRoot } from "./git-worktrees"

type WorktreeCacheEntry = {
  expiresAt: number
  repoRoot: string
  worktrees: Array<{ slug: string; directory: string }>
}

const WORKTREE_CACHE_TTL_MS = 2000
const worktreeCache = new Map<string, WorktreeCacheEntry>()

async function getCachedWorktrees(params: { workspaceId: string; workspacePath: string; logger?: LogLike }) {
  const cached = worktreeCache.get(params.workspaceId)
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    return cached
  }

  const { repoRoot } = await resolveRepoRoot(params.workspacePath, params.logger)
  const worktrees = await listWorktrees({ repoRoot, workspaceFolder: params.workspacePath, logger: params.logger })
  const entry: WorktreeCacheEntry = {
    expiresAt: now + WORKTREE_CACHE_TTL_MS,
    repoRoot,
    worktrees: worktrees.map((wt) => ({ slug: wt.slug, directory: wt.directory })),
  }
  worktreeCache.set(params.workspaceId, entry)
  return entry
}

export async function resolveWorktreeDirectory(params: {
  workspaceId: string
  workspacePath: string
  worktreeSlug: string
  logger?: LogLike
}): Promise<string | null> {
  const cached = await getCachedWorktrees({
    workspaceId: params.workspaceId,
    workspacePath: params.workspacePath,
    logger: params.logger,
  })
  const match = cached.worktrees.find((wt) => wt.slug === params.worktreeSlug)
  if (match) {
    return match.directory
  }

  worktreeCache.delete(params.workspaceId)
  const refreshed = await getCachedWorktrees({
    workspaceId: params.workspaceId,
    workspacePath: params.workspacePath,
    logger: params.logger,
  })
  return refreshed.worktrees.find((wt) => wt.slug === params.worktreeSlug)?.directory ?? null
}
