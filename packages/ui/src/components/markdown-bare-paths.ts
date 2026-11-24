/** Existence verification and conversion for bare file paths in session
 * markdown: one coalesced, TTL-bounded directory listing per worktree
 * directory, fail closed (an unreadable or unknown directory converts
 * nothing), and a DOM pass that re-reads the container at wrap time so the
 * markdown pipeline's fallback/final commits never strand a wrap. */

import { backendOf } from "../lib/backend-client"
import { barePathCandidates, type BarePathCandidate } from "../lib/markdown-bare-paths"
import { resolveProjectLinkPath } from "../lib/markdown-project-links"
import type { SessionLinkBase } from "./markdown-session-links"

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
  // The flight's placeholder overwrites this slot; remember the completed
  // entry it replaces so a failed refresh can keep its last good set.
  const prior = existing !== undefined && existing.flight === undefined ? existing : undefined

  const flight = (async (): Promise<Set<string>> => {
    let fetched: Set<string> | undefined
    try {
      const entries = (await backendOf(instanceId).api
        .listWorkspaceFiles(instanceId, parentPath || ".", directory, signal)) as Array<{ name: string; type?: string }>
      fetched = new Set(entries.filter(entry => entry.type !== "directory").map(entry => entry.name))
    } catch {
      // A failed read verifies nothing; the caller converts no paths.
    }
    if (fetched === undefined) {
      // Preserve a last good set and its staleness, so the next demand
      // retries; a first failure caches emptiness until the TTL revalidates.
      const files = prior?.files ?? new Set<string>()
      cache.set(key, { files, at: prior?.at ?? Date.now() })
      return files
    }
    cache.set(key, { files: fetched, at: Date.now() })
    return fetched
  })()
  cache.set(key, { files: existing?.files ?? new Set<string>(), at: existing?.at ?? 0, flight })
  evictOldestIdleEntry()
  return flight
}

export interface LinkBarePathsOptions {
  instanceId: string
  sessionId: string
  base: SessionLinkBase
  titles: { preview: string; file: string }
  signal: AbortSignal
}

interface ResolvedTarget {
  parent: string
  name: string
}

const SKIP_TEXT = "code, pre, a, [data-local-image]"

const walkHits = (container: ParentNode) => {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node: Node) => {
      const parent = (node as Text).parentElement
      if (!parent || parent.closest(SKIP_TEXT)) return NodeFilter.FILTER_REJECT
      return (node.nodeValue ?? "").trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  const hits: Array<{ node: Text; candidates: BarePathCandidate[] }> = []
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const candidates = barePathCandidates(node.nodeValue ?? "")
    if (candidates.length) hits.push({ node, candidates })
  }
  return hits
}

const resolveTarget = (href: string, base: string): ResolvedTarget | undefined => {
  const resolved = resolveProjectLinkPath(href, base)
  if (resolved === undefined) return undefined
  const lastSlash = resolved.lastIndexOf("/")
  return { parent: lastSlash < 0 ? "" : resolved.slice(0, lastSlash), name: lastSlash < 0 ? resolved : resolved.slice(lastSlash + 1) }
}

/** One existence-gated pass over a rendered markdown container: bare-path
 * candidates that resolve inside the session's worktree and exist as files
 * become anchors the shared click routing and link decoration already
 * serve. The container is walked once to warm the directory cache and walked
 * again after the listings land, so a fallback/final html commit between the
 * two walks can never strand a wrap. Fire-and-forget; errors never break
 * rendering. */
export function linkBarePaths(container: ParentNode, options: LinkBarePathsOptions): void {
  void (async () => {
    try {
      const parents = new Set<string>()
      for (const { candidates } of walkHits(container)) {
        for (const candidate of candidates) {
          const target = resolveTarget(candidate.href, options.base.base)
          if (target) parents.add(target.parent)
        }
      }
      if (!parents.size || options.signal.aborted || !container.isConnected) return
      const unique = [...parents]
      const nameSets = new Map(await Promise.all(unique.map(async parent =>
        [parent, await fileNamesInDirectory(options.instanceId, options.base.directory, parent, options.signal)] as const)))
      if (options.signal.aborted || !container.isConnected) return

      // Re-read the container: the markdown pipeline may have replaced its
      // children while the listings were in flight.
      let wrapped = false
      for (const { node, candidates } of walkHits(container)) {
        const matches = candidates
          .map(candidate => ({ candidate, target: resolveTarget(candidate.href, options.base.base) }))
          .filter(({ target }) => target !== undefined && nameSets.get(target.parent)?.has(target.name))
          .sort((left, right) => right.candidate.start - left.candidate.start)
        if (!matches.length) continue
        for (const { candidate } of matches) {
          if (candidate.end < node.nodeValue!.length) node.splitText(candidate.end)
          const target = candidate.start > 0 ? node.splitText(candidate.start) : node
          const anchor = document.createElement("a")
          anchor.setAttribute("href", candidate.href)
          const range = document.createRange()
          range.setStart(target, 0)
          range.setEnd(target, candidate.end - candidate.start)
          range.surroundContents(anchor)
        }
        wrapped = true
      }
      if (wrapped) {
        // Loaded dynamically: this module stays importable outside the browser.
        const { decorateSessionLinks } = await import("./markdown-session-links")
        decorateSessionLinks(container, options.titles, options.base)
      }
    } catch {
      // Conversion is decoration; it never breaks rendering.
    }
  })()
}
