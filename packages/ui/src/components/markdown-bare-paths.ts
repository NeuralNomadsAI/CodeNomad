/** Existence verification and conversion for bare file paths in session
 * markdown: one coalesced, TTL-bounded directory listing per worktree
 * directory, fail closed (an unreadable or unknown directory converts
 * nothing), and a DOM pass that re-reads the container at wrap time so the
 * markdown pipeline's fallback/final commits never strand a wrap. */

import { backendOf } from "../lib/backend-client"
import { backgroundReads } from "../lib/background-read-queue"
import { barePathCandidates, type BarePathCandidate, type BarePathPiece } from "../lib/markdown-bare-paths"
import { resolveProjectLinkPath } from "../lib/markdown-project-links"
import { canOpenLocalPaths } from "../lib/workspace-open"
import type { SessionLinkBase, SessionLinkTitles } from "./markdown-session-links"

interface FlightState {
  controller: AbortController
  consumers: Set<AbortSignal>
  /** Callers without a signal never leave; they keep the flight alive. */
  residents: number
  deadline: ReturnType<typeof setTimeout>
  revoked: boolean
  settled: boolean
}

interface DirectoryCacheEntry {
  files: Set<string>
  at: number
  flight?: Promise<Set<string>>
  state?: FlightState
}

const MAX_CACHE_ENTRIES = 64

/** A stale entry revalidates on its next demand; no background polling. */
export const BARE_PATH_TTL_MS = 30_000

/** A dispatched listing never holds a background slot beyond this deadline. */
export const BARE_PATH_LISTING_DEADLINE_MS = 15_000

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

/** A consumer's leaving only counts once no successor holds the flight: a
 * streaming rerender registers its replacement in the same flush, so the
 * abandonment check waits one macrotask before revoking the read. */
const trackConsumer = (signal: AbortSignal | undefined, state: FlightState, key: string) => {
  if (!signal) {
    state.residents += 1
    return
  }
  state.consumers.add(signal)
  signal.addEventListener("abort", () => {
    state.consumers.delete(signal)
    if (state.consumers.size > 0 || state.residents > 0 || state.settled || state.revoked) return
    setTimeout(() => {
      if (state.settled || state.revoked || state.consumers.size > 0 || state.residents > 0) return
      // The last consumer left: revoke the entry (nothing publishes) and free
      // the background slot for the next reader.
      state.revoked = true
      clearTimeout(state.deadline)
      const entry = cache.get(key)
      if (entry?.state === state) cache.delete(key)
      state.controller.abort()
    }, 0)
  }, { once: true })
}

/** Linkable names of one directory inside the worktree `directory`: files,
 * and folders where they open with the system. Concurrent
 * and sequential callers share one flight; a render pass may leave through
 * its signal, and the listing is cancelled only when the last consumer has
 * gone — a streaming rerender's successor keeps it alive. Every dispatched
 * listing carries a deadline, and a failed read keeps the last good set (or
 * caches an empty set when none exists) so prose false positives stay
 * cheap. */
export function fileNamesInDirectory(instanceId: string, directory: string, parentPath: string, options?: { signal?: AbortSignal }): Promise<Set<string>> {
  const key = `${instanceId}\u0000${directory}\u0000${parentPath}`
  const existing = cache.get(key)
  if (existing?.flight) {
    trackConsumer(options?.signal, existing.state!, key)
    return existing.flight
  }
  if (existing && Date.now() - existing.at < BARE_PATH_TTL_MS) return Promise.resolve(existing.files)
  // The flight's placeholder overwrites this slot; remember the completed
  // entry it replaces so a failed refresh can keep its last good set.
  const prior = existing !== undefined && existing.flight === undefined ? existing : undefined

  const state: FlightState = {
    controller: new AbortController(),
    consumers: new Set(),
    residents: 0,
    deadline: setTimeout(() => state.controller.abort(), BARE_PATH_LISTING_DEADLINE_MS),
    revoked: false,
    settled: false,
  }
  trackConsumer(options?.signal, state, key)
  const flight = (async (): Promise<Set<string>> => {
    let fetched: Set<string> | undefined
    try {
      // Passive transcript decoration borrows the shared background budget:
      // a summary naming many directories queues behind visible reads and
      // never crowds out foreground connections. The flight's own signal is
      // never aborted — its lifetime belongs to the cache, not a caller.
      const entries = (await backgroundReads.run(state.controller.signal, async () =>
        backendOf(instanceId).api.listWorkspaceFiles(instanceId, parentPath || ".", directory, state.controller.signal))) as Array<{ name: string; type?: string }>
      // Folders link only where a click opens them with the system.
      const folders = canOpenLocalPaths(instanceId)
      fetched = new Set(entries.filter(entry => folders || entry.type !== "directory").map(entry => entry.name))
    } catch {
      // A failed read verifies nothing; the caller converts no paths.
    } finally {
      state.settled = true
      clearTimeout(state.deadline)
    }
    if (state.revoked) {
      // The last consumer left before the read settled; nothing publishes.
      return new Set<string>()
    }
    if (fetched === undefined) {
      // Preserve a last good set and its staleness, so the next demand
      // retries; a first failure (or a deadline) caches emptiness until the
      // TTL revalidates it.
      const files = prior?.files ?? new Set<string>()
      cache.set(key, { files, at: prior?.at ?? Date.now() })
      return files
    }
    cache.set(key, { files: fetched, at: Date.now() })
    return fetched
  })()
  cache.set(key, { files: existing?.files ?? new Set<string>(), at: existing?.at ?? 0, flight, state })
  evictOldestIdleEntry()
  return flight
}

export interface LinkBarePathsOptions {
  instanceId: string
  sessionId: string
  base: SessionLinkBase
  titles: SessionLinkTitles
  signal: AbortSignal
}

interface ResolvedTarget {
  parent: string
  name: string
}

// Inline code spans carry file paths agents backtick constantly, so they
// convert like prose; fenced code blocks (`pre`) stay literal, as do
// hand-written links and local-image labels.
const SKIP_TEXT = "pre, a, [data-local-image]"

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
 * candidates that resolve inside the session's worktree and name a linkable entry
 * become anchors the shared click routing and link decoration already
 * serve. A token with non-ASCII letters offers its integral reading first —
 * the whole token as one path with the letters in its name — and falls back
 * to its boundary pieces, which convert independently exactly as the
 * ASCII-only grammar did. The container is walked once to warm the directory
 * cache and walked again after the listings land, so a fallback/final html
 * commit between the two walks can never strand a wrap. Fire-and-forget;
 * errors never break rendering. */
export function linkBarePaths(container: ParentNode, options: LinkBarePathsOptions): void {
  void (async () => {
    try {
      const parents = new Set<string>()
      for (const { candidates } of walkHits(container)) {
        for (const candidate of candidates) {
          for (const piece of candidate.integral ? [candidate.integral, ...candidate.pieces] : candidate.pieces) {
            const target = resolveTarget(piece.href, options.base.base)
            if (target) parents.add(target.parent)
          }
        }
      }
      if (!parents.size || options.signal.aborted || !container.isConnected) return
      const unique = [...parents]
      const nameSets = new Map(await Promise.all(unique.map(async parent =>
        [parent, await fileNamesInDirectory(options.instanceId, options.base.directory, parent, { signal: options.signal })] as const)))
      if (options.signal.aborted || !container.isConnected) return

      // Re-read the container: the markdown pipeline may have replaced its
      // children while the listings were in flight.
      let wrapped = false
      for (const { node, candidates } of walkHits(container)) {
        const matches: BarePathPiece[] = []
        for (const candidate of candidates) {
          if (candidate.integral) {
            const target = resolveTarget(candidate.integral.href, options.base.base)
            if (target !== undefined && nameSets.get(target.parent)?.has(target.name)) {
              matches.push(candidate.integral)
              continue
            }
          }
          for (const piece of candidate.pieces) {
            const target = resolveTarget(piece.href, options.base.base)
            if (target !== undefined && nameSets.get(target.parent)?.has(target.name)) matches.push(piece)
          }
        }
        if (!matches.length) continue
        matches.sort((left, right) => right.start - left.start)
        for (const piece of matches) {
          if (piece.end < node.nodeValue!.length) node.splitText(piece.end)
          const target = piece.start > 0 ? node.splitText(piece.start) : node
          const anchor = document.createElement("a")
          anchor.setAttribute("href", piece.href)
          const range = document.createRange()
          range.setStart(target, 0)
          range.setEnd(target, piece.end - piece.start)
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
