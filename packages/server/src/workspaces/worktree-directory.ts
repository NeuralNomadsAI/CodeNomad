import { lstat, realpath } from "fs/promises"
import path from "node:path"
import type { LogLike } from "./git-worktrees"
import { listWorktrees, resolveRepoRoot } from "./git-worktrees"

type WorktreeCacheEntry = {
  expiresAt: number
  repoRoot: string
  worktrees: Array<{ slug: string; directory: string; normalizedDirectory: string }>
  resolvedDirectories: Map<string, { slug: string; directory: string; worktreeDirectory: string }>
}

const WORKTREE_CACHE_TTL_MS = 2000
const worktreeCache = new Map<string, WorktreeCacheEntry>()

async function normalizeDirectoryPath(directory: string): Promise<string> {
  const trimmed = (directory ?? "").trim()
  if (!trimmed) return ""
  try {
    return await realpath(trimmed)
  } catch {
    return trimmed
  }
}

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
    worktrees: await Promise.all(
      worktrees.map(async (wt) => ({
        slug: wt.slug,
        directory: wt.directory,
        normalizedDirectory: await normalizeDirectoryPath(wt.directory),
      })),
    ),
    resolvedDirectories: new Map(),
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

export async function resolveWorktreeSlugForDirectory(params: {
  workspaceId: string
  workspacePath: string
  directory: string
  logger?: LogLike
}): Promise<string | null> {
  const target = await normalizeDirectoryPath(params.directory ?? "")
  if (!target) return null

  const cached = await getCachedWorktrees({
    workspaceId: params.workspaceId,
    workspacePath: params.workspacePath,
    logger: params.logger,
  })
  const match = cached.worktrees.find((wt) => wt.normalizedDirectory === target)
  if (match) {
    return match.slug
  }

  worktreeCache.delete(params.workspaceId)
  const refreshed = await getCachedWorktrees({
    workspaceId: params.workspaceId,
    workspacePath: params.workspacePath,
    logger: params.logger,
  })
  return refreshed.worktrees.find((wt) => wt.normalizedDirectory === target)?.slug ?? null
}

async function resolveDirectoryPath(directory: string): Promise<string | null> {
  const trimmed = (directory ?? "").trim()
  if (!trimmed) return null
  let current = path.resolve(trimmed)
  const missing: string[] = []
  while (true) {
    try {
      return path.join(await realpath(current), ...missing)
    } catch {
      try {
        await lstat(current)
        return null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null
      }
      const parent = path.dirname(current)
      if (parent === current) return null
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

export function normalizeWslUncPath(directory: string): string | null {
  const normalized = directory.replace(/\\/g, "/").replace(/\/+$/, "")
  const match = /^(\/\/wsl(?:\.localhost|\$)\/)([^/]+)(.*)$/i.exec(normalized)
  return match ? `${match[1].toLowerCase()}${match[2].toLowerCase()}${match[3]}` : null
}

export function isPathWithinWorktree(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeWslUncPath(root)
  if (normalizedRoot) {
    const normalizedCandidate = normalizeWslUncPath(candidate)
    if (!normalizedCandidate) return false
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  }
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export async function resolveOwnedWorktreePath(params: {
  workspaceId: string
  workspacePath: string
  directory: string
  logger?: LogLike
}): Promise<{ slug: string; directory: string; worktreeDirectory: string } | null> {
  const target = await resolveDirectoryPath(params.directory)
  if (!target) return null
  const find = (worktrees: WorktreeCacheEntry["worktrees"]) => worktrees
    .filter((worktree) => isPathWithinWorktree(worktree.normalizedDirectory, target))
    .sort((left, right) => right.normalizedDirectory.length - left.normalizedDirectory.length)[0]
  let entry = await getCachedWorktrees(params)
  const known = entry.resolvedDirectories.get(target)
  if (known) return known
  let match = find(entry.worktrees)
  if (!match || (match.slug === "root" && match.normalizedDirectory !== target)) {
    worktreeCache.delete(params.workspaceId)
    entry = await getCachedWorktrees(params)
    match = find(entry.worktrees)
  }
  const resolved = match ? { slug: match.slug, directory: target, worktreeDirectory: match.normalizedDirectory } : null
  if (resolved) entry.resolvedDirectories.set(target, resolved)
  return resolved
}

export async function isPathOwnedByWorktree(params: {
  workspaceId: string
  workspacePath: string
  candidate: string
  logger?: LogLike
}): Promise<boolean> {
  let target: string
  try {
    target = await realpath(params.candidate)
  } catch {
    return false
  }
  const cached = await getCachedWorktrees(params)
  return cached.worktrees.some((worktree) => isPathWithinWorktree(worktree.normalizedDirectory, target))
}
