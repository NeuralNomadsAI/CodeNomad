import path from "path"
import type { FileSystemEntry } from "../api-types"

export const WORKSPACE_CANDIDATE_CACHE_TTL_MS = 30_000

interface WorkspaceCandidateCacheEntry {
  scope: string
  expiresAt: number
  candidates: FileSystemEntry[]
}

const workspaceCandidateCache = new Map<string, WorkspaceCandidateCacheEntry>()

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

export function refreshWorkspaceCandidates(
  rootDir: string,
  scope: string,
  builder: () => FileSystemEntry[],
  now = Date.now(),
): FileSystemEntry[] {
  const key = normalizeKey(rootDir)
  const freshCandidates = builder()

  const storedCandidates = cloneEntries(freshCandidates)
  workspaceCandidateCache.set(key, {
    scope,
    expiresAt: now + WORKSPACE_CANDIDATE_CACHE_TTL_MS,
    candidates: storedCandidates,
  })

  return cloneEntries(storedCandidates)
}

export function clearWorkspaceSearchCache(rootDir?: string) {
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
