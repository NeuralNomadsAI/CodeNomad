import path from "path"
import type { FileSystemEntry } from "../api-types"

export const WORKSPACE_CANDIDATE_CACHE_TTL_MS = 30_000

interface WorkspaceCandidateCacheEntry {
  scope: string
  expiresAt: number
  candidates: FileSystemEntry[]
}

const workspaceCandidateCache = new Map<string, WorkspaceCandidateCacheEntry>()
const pendingScans = new Map<string, { root: string; valid: boolean; request: Promise<FileSystemEntry[]> }>()
const MAX_ACTIVE_SCANS = 2

export class WorkspaceSearchBusyError extends Error {
  constructor() {
    super("File search is busy; retry after the current scans finish")
  }
}

export function getWorkspaceCandidates(rootDir: string, scope: string, now = Date.now()): FileSystemEntry[] | undefined {
  const key = normalizeKey(rootDir)
  const cached = workspaceCandidateCache.get(key)
  if (!cached || cached.scope !== scope) {
    return undefined
  }

  if (cached.expiresAt <= now) {
    workspaceCandidateCache.delete(key)
    return undefined
  }

  return cloneEntries(cached.candidates)
}

export async function refreshWorkspaceCandidates(
  rootDir: string,
  scope: string,
  builder: () => FileSystemEntry[] | Promise<FileSystemEntry[]>,
  now?: number,
): Promise<FileSystemEntry[]> {
  const key = normalizeKey(rootDir)
  const scanKey = `${key}\0${scope}`
  const pending = pendingScans.get(scanKey)
  if (pending) return cloneEntries(await pending.request)
  // Keep a stalled disk from filling the filesystem pool with duplicate scans.
  // Retain ownership until the real I/O settles, even after cache invalidation.
  if (pendingScans.size >= MAX_ACTIVE_SCANS) throw new WorkspaceSearchBusyError()
  const scan = { root: key, valid: true, request: Promise.resolve().then(builder) }
  pendingScans.set(scanKey, scan)
  try {
    const candidates = cloneEntries(await scan.request)
    if (scan.valid) workspaceCandidateCache.set(key, {
      scope,
      expiresAt: (now ?? Date.now()) + WORKSPACE_CANDIDATE_CACHE_TTL_MS,
      candidates,
    })
    return cloneEntries(candidates)
  } finally {
    pendingScans.delete(scanKey)
  }
}

export function clearWorkspaceSearchCache(rootDir?: string) {
  for (const scan of pendingScans.values()) {
    if (rootDir === undefined || scan.root === normalizeKey(rootDir)) scan.valid = false
  }
  if (typeof rootDir === "undefined") {
    workspaceCandidateCache.clear()
    return
  }

  workspaceCandidateCache.delete(normalizeKey(rootDir))
}

function cloneEntries(entries: FileSystemEntry[]): FileSystemEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

function normalizeKey(rootDir: string) {
  return path.resolve(rootDir)
}
