import { lstat, realpath } from "fs/promises"
import path from "node:path"
import type { LogLike } from "./git-worktrees"
import type { WorktreeDescriptor } from "../api-types"

type WorktreeSource = { loadWorktrees: (refresh?: boolean) => Promise<WorktreeDescriptor[]> }

type WorktreeCacheEntry = {
  expiresAt: number
  refreshedOnMiss: boolean
  worktrees: Array<{ slug: string; directory: string; normalizedDirectory: string; worktreeDirectory: string; directoryOnly?: boolean; discoveryUnverified?: boolean }>
  resolvedDirectories: Map<string, { slug: string; directory: string; worktreeDirectory: string } | null>
}

const WORKTREE_CACHE_TTL_MS = 10_000
const worktreeCache = new Map<string, WorktreeCacheEntry>()
const worktreeLoads = new Map<string, Promise<WorktreeCacheEntry | null>>()

function restartWorktreeRead(budget: { restarts: number }): boolean {
  if (budget.restarts >= 3) throw new Error("Worktree ownership inventory changed repeatedly")
  return ++budget.restarts === 3
}

async function normalizeDirectoryPath(directory: string): Promise<string> {
  const trimmed = (directory ?? "").trim()
  if (!trimmed) return ""
  try {
    return await realpath(trimmed)
  } catch {
    return trimmed
  }
}

async function getCachedWorktrees(
  params: WorktreeSource & { workspaceId: string; workspacePath: string; logger?: LogLike },
  refresh = false,
  budget = { restarts: 0 },
): Promise<WorktreeCacheEntry> {
  const cached = worktreeCache.get(params.workspaceId)
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    return cached
  }

  let load = worktreeLoads.get(params.workspaceId)
  if (!load) {
    let scan!: Promise<WorktreeCacheEntry | null>
    scan = (async () => {
      const worktrees = await params.loadWorktrees(refresh)
      const entry: WorktreeCacheEntry = {
        expiresAt: Date.now() + WORKTREE_CACHE_TTL_MS,
        refreshedOnMiss: false,
        worktrees: await Promise.all(
          worktrees.map(async (wt) => ({
            slug: wt.slug,
            directory: wt.directory,
            normalizedDirectory: await normalizeDirectoryPath(wt.directory),
            worktreeDirectory: await normalizeDirectoryPath(wt.registeredDirectory ?? wt.directory),
            directoryOnly: wt.directoryOnly,
            discoveryUnverified: wt.discoveryUnverified,
          })),
        ),
        resolvedDirectories: new Map(),
      }
      // Share one scan, never another caller's retry chain or budget.
      if (worktreeLoads.get(params.workspaceId) !== scan) return null
      worktreeCache.set(params.workspaceId, entry)
      return entry
    })().finally(() => {
      if (worktreeLoads.get(params.workspaceId) === scan) worktreeLoads.delete(params.workspaceId)
    })
    worktreeLoads.set(params.workspaceId, scan)
    load = scan
  }
  const entry = await load
  if (entry && worktreeCache.get(params.workspaceId) === entry) return entry
  return getCachedWorktrees(params, restartWorktreeRead(budget), budget)
}

export function invalidateWorktreeCache(workspaceId?: string): void {
  if (workspaceId === undefined) {
    worktreeCache.clear()
    worktreeLoads.clear()
  } else {
    worktreeCache.delete(workspaceId)
    worktreeLoads.delete(workspaceId)
  }
}

export async function resolveWorktreeDirectory(params: WorktreeSource & {
  workspaceId: string
  workspacePath: string
  worktreeSlug: string
  logger?: LogLike
}): Promise<string | null> {
  const cached = await getCachedWorktrees({
    workspaceId: params.workspaceId,
    workspacePath: params.workspacePath,
    logger: params.logger,
    loadWorktrees: params.loadWorktrees,
  })
  const match = cached.worktrees.find((wt) => wt.slug === params.worktreeSlug)
  if (match) {
    return match.directory
  }

  invalidateWorktreeCache(params.workspaceId)
  const refreshed = await getCachedWorktrees({
    workspaceId: params.workspaceId,
    workspacePath: params.workspacePath,
    logger: params.logger,
    loadWorktrees: params.loadWorktrees,
  }, true)
  return refreshed.worktrees.find((wt) => wt.slug === params.worktreeSlug)?.directory ?? null
}

export async function resolveWorktreeSlugForDirectory(params: WorktreeSource & {
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
    loadWorktrees: params.loadWorktrees,
  })
  const match = cached.worktrees.find((wt) => wt.normalizedDirectory === target)
  if (match) {
    return match.slug
  }

  invalidateWorktreeCache(params.workspaceId)
  const refreshed = await getCachedWorktrees({
    workspaceId: params.workspaceId,
    workspacePath: params.workspacePath,
    logger: params.logger,
    loadWorktrees: params.loadWorktrees,
  }, true)
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

export async function resolveOwnedWorktreePath(params: WorktreeSource & {
  workspaceId: string
  workspacePath: string
  directory: string
  strict?: boolean
  logger?: LogLike
}, budget = { restarts: 0 }): Promise<{ slug: string; directory: string; worktreeDirectory: string } | null> {
  const target = params.strict ? await realpath(params.directory) : await resolveDirectoryPath(params.directory)
  if (!target) return null
  const find = async (worktrees: WorktreeCacheEntry["worktrees"]) => {
    if (params.strict && worktrees.some(worktree => worktree.directoryOnly || worktree.discoveryUnverified)) throw new Error("Git ownership inventory unavailable")
    return (params.strict
    ? (await Promise.all(worktrees.map(async worktree => {
      const worktreeDirectory = await realpath(worktree.worktreeDirectory)
      try {
        return { ...worktree, worktreeDirectory, normalizedDirectory: await realpath(worktree.directory) }
      } catch (error) {
        // A nested project folder may exist in only some registered checkouts.
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && worktree.slug !== "root" && worktree.directory !== worktree.worktreeDirectory) return null
        throw error
      }
    }))).filter((worktree): worktree is NonNullable<typeof worktree> => worktree !== null)
    : worktrees)
    .filter((worktree) => worktree.directoryOnly ? worktree.normalizedDirectory === target : isPathWithinWorktree(worktree.normalizedDirectory, target))
    .sort((left, right) => right.normalizedDirectory.length - left.normalizedDirectory.length)[0]
  }
  let entry = await getCachedWorktrees(params, budget.restarts === 3, budget)
  if (!params.strict && entry.resolvedDirectories.has(target)) return entry.resolvedDirectories.get(target)!
  let match = await find(entry.worktrees)
  if (worktreeCache.get(params.workspaceId) !== entry) {
    restartWorktreeRead(budget)
    return resolveOwnedWorktreePath(params, budget)
  }
  if (budget.restarts < 3 && !entry.refreshedOnMiss && (!match || (match.slug === "root" && match.normalizedDirectory !== target))) {
    // Refresh once for this cache lifetime, including sequential misses from
    // distinct foreign event locations. Otherwise every miss discards the last
    // negative result and stalls the serial native event bridge on inventory I/O.
    if (worktreeCache.get(params.workspaceId) === entry) worktreeCache.delete(params.workspaceId)
    entry = await getCachedWorktrees(params, true, budget)
    entry.refreshedOnMiss = true
    match = await find(entry.worktrees)
  }
  if (worktreeCache.get(params.workspaceId) !== entry) {
    restartWorktreeRead(budget)
    return resolveOwnedWorktreePath(params, budget)
  }
  const resolved = match ? { slug: match.slug, directory: target, worktreeDirectory: match.worktreeDirectory } : null
  entry.resolvedDirectories.set(target, resolved)
  return resolved
}

export async function isPathOwnedByWorktree(params: WorktreeSource & {
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
