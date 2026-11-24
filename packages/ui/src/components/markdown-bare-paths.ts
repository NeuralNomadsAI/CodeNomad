/** Existence verification for bare file paths in session markdown: one
 * coalesced, TTL-bounded directory listing per worktree directory, fail
 * closed (an unreadable or unknown directory converts nothing). The DOM pass
 * that consumes this cache lives here too (see linkBarePaths). */

import { backendOf } from "../lib/backend-client"

interface DirectoryCacheEntry {
  files: Set<string>
  at: number
  flight?: Promise<Set<string>>
}

const MAX_CACHE_ENTRIES = 64

/** A stale entry revalidates on its next demand; no background polling. */
export const BARE_PATH_TTL_MS = 30_000

const cache = new Map<string, DirectoryCacheEntry>()

export function clearBarePathCaches(): void {
  cache.clear()
}

const evictOldestIdleEntry = () => {
  if (cache.size <= MAX_CACHE_ENTRIES) return
  let oldest: string | undefined, oldestAt = Infinity
  for (const [key, entry] of cache) {
    if (entry.flight || entry.at >= oldestAt) continue
    oldest = key
    oldestAt = entry.at
  }
  if (oldest !== undefined) cache.delete(oldest)
}

/** File names of one directory inside the worktree `directory`. Concurrent
 * callers share one flight; a failed read keeps the last good set (or caches
 * an empty set when none exists) so prose false positives stay cheap. */
export function fileNamesInDirectory(instanceId: string, directory: string, parentPath: string, signal?: AbortSignal): Promise<Set<string>> {
  const key = `${instanceId}\u0000${directory}\u0000${parentPath}`
  const existing = cache.get(key)
  if (existing?.flight) return existing.flight
  if (existing && Date.now() - existing.at < BARE_PATH_TTL_MS) return Promise.resolve(existing.files)

  const flight = (async (): Promise<Set<string>> => {
    let fetched: Set<string> | undefined
    try {
      const entries = (await backendOf(instanceId).api
        .listWorkspaceFiles(instanceId, parentPath || ".", directory, signal)) as Array<{ name: string; type?: string }>
      fetched = new Set(entries.filter(entry => entry.type !== "directory").map(entry => entry.name))
    } catch {
      // A failed read verifies nothing; the caller converts no paths.
    }
    const previous = cache.get(key)
    if (previous?.flight === flight) previous.flight = undefined
    if (fetched === undefined) {
      // Preserve a last good set and its staleness, so the next demand retries;
      // a first failure caches emptiness until the TTL revalidates it.
      const empty = new Set<string>()
      if (!previous) cache.set(key, { files: empty, at: Date.now() })
      return previous?.files ?? empty
    }
    cache.set(key, { files: fetched, at: Date.now() })
    return fetched
  })()
  cache.set(key, { files: existing?.files ?? new Set<string>(), at: existing?.at ?? 0, flight })
  evictOldestIdleEntry()
  return flight
}
