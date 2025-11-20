import path from "path"
import type { FileSystemEntry } from "../api-types"

export const WORKSPACE_CANDIDATE_CACHE_TTL_MS = 30_000

interface WorkspaceCandidateCacheEntry {
  expiresAt: number
  candidates: FileSystemEntry[]
}

const workspaceCandidateCache = new Map<string, WorkspaceCandidateCacheEntry>()

export function getWorkspaceCandidates(rootDir: string, now = Date.now()): FileSystemEntry[] | undefined {
  const key = normalizeKey(rootDir)
  const cached = workspaceCandidateCache.get(key)
  if (!cached) {
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
  builder: () => FileSystemEntry[],
  now = Date.now(),
): FileSystemEntry[] {
  const key = normalizeKey(rootDir)
  const freshCandidates = builder()

  if (!freshCandidates || freshCandidates.length === 0) {
    workspaceCandidateCache.delete(key)
    return []
  }

  const storedCandidates = cloneEntries(freshCandidates)
  workspaceCandidateCache.set(key, {
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

  const key = normalizeKey(rootDir)
  workspaceCandidateCache.delete(key)
}

function cloneEntries(entries: FileSystemEntry[]): FileSystemEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

function normalizeKey(rootDir: string) {
  return path.resolve(rootDir)
}
