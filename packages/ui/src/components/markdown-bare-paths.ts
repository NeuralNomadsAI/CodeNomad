/** Existence verification and conversion for bare file paths in session
 * markdown: one coalesced, TTL-bounded directory listing per worktree
 * directory, fail closed (an unreadable or unknown directory converts
 * nothing), and a DOM pass that re-reads the container at wrap time so the
 * markdown pipeline's fallback/final commits never strand a wrap. */

import { backendOf } from "../lib/backend-client"
import { backgroundReads } from "../lib/background-read-queue"
import { barePathCandidates, type BarePathCandidate } from "../lib/markdown-bare-paths"
import { resolveProjectLinkPath } from "../lib/markdown-project-links"
import type { SessionLinkBase } from "./markdown-session-links"

interface FlightState {
  controller: AbortController
  consumers: Set<AbortSignal>
  /** Callers without a signal never leave; they keep the flight alive. */
  residents: number
  deadline: ReturnType<typeof setTimeout>
  revoked: boolean
  settled: boolean
}

/** Entry names of one listed directory and whether each is a folder. */
export type DirectoryEntries = Map<string, "file" | "directory">

interface DirectoryCacheEntry {
  entries: DirectoryEntries
  at: number
  flight?: Promise<DirectoryEntries>
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

/** The entries of one directory inside the worktree `directory`. Concurrent
 * and sequential callers share one flight; a render pass may leave through
 * its signal, and the listing is cancelled only when the last consumer has
 * gone — a streaming rerender's successor keeps it alive. Every dispatched
 * listing carries a deadline, and a failed read keeps the last good set (or
 * caches an empty set when none exists) so prose false positives stay
 * cheap. */
export function directoryEntries(instanceId: string, directory: string, parentPath: string, options?: { signal?: AbortSignal }): Promise<DirectoryEntries> {
  const key = `${instanceId}\u0000${directory}\u0000${parentPath}`
  const existing = cache.get(key)
  if (existing?.flight) {
    trackConsumer(options?.signal, existing.state!, key)
    return existing.flight
  }
  if (existing && Date.now() - existing.at < BARE_PATH_TTL_MS) return Promise.resolve(existing.entries)
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
  const flight = (async (): Promise<DirectoryEntries> => {
    let fetched: DirectoryEntries | undefined
    try {
      // Passive transcript decoration borrows the shared background budget:
      // a summary naming many directories queues behind visible reads and
      // never crowds out foreground connections. The flight's own signal is
      // never aborted — its lifetime belongs to the cache, not a caller.
      const entries = (await backgroundReads.run(state.controller.signal, async () =>
        backendOf(instanceId).api.listWorkspaceFiles(instanceId, parentPath || ".", directory, state.controller.signal))) as Array<{ name: string; type?: string }>
      fetched = new Map(entries.map(entry => [entry.name, entry.type === "directory" ? "directory" : "file"]))
    } catch {
      // A failed read verifies nothing; the caller converts no paths.
    } finally {
      state.settled = true
      clearTimeout(state.deadline)
    }
    if (state.revoked) {
      // The last consumer left before the read settled; nothing publishes.
      return new Map()
    }
    if (fetched === undefined) {
      // Preserve a last good set and its staleness, so the next demand
      // retries; a first failure (or a deadline) caches emptiness until the
      // TTL revalidates it.
      const entries = prior?.entries ?? new Map()
      cache.set(key, { entries, at: prior?.at ?? Date.now() })
      return entries
    }
    cache.set(key, { entries: fetched, at: Date.now() })
    return fetched
  })()
  cache.set(key, { entries: existing?.entries ?? new Map(), at: existing?.at ?? 0, flight, state })
  evictOldestIdleEntry()
  return flight
}

export interface LinkBarePathsOptions {
  instanceId: string
  sessionId: string
  base: SessionLinkBase
  titles: { preview: string; file: string }
  /** Folders link and open natively (see nativeFolderSlug). */
  folders: boolean
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

/** Marks session links naming a worktree folder; the click routing opens them
 * in the system file manager. */
export const PROJECT_FOLDER_ATTRIBUTE = "data-project-folder"

/** An entry's kind; names compare case-insensitively under a Windows root. */
export const entryKind = (entries: DirectoryEntries | undefined, name: string, windows: boolean) => {
  const exact = entries?.get(name)
  if (exact || !windows || !entries) return exact
  const key = name.toLowerCase()
  for (const [entry, kind] of entries) if (entry.toLowerCase() === key) return kind
  return undefined
}

/** One existence-gated pass over a rendered markdown container: bare-path
 * candidates that resolve inside the session's worktree and name a file (or a
 * folder, with `folders`) become anchors the shared click routing and link
 * decoration already serve, and with `folders` every link naming a worktree
 * folder carries `PROJECT_FOLDER_ATTRIBUTE`. The container is walked once to
 * warm the directory cache and walked again after the listings land, so a
 * fallback/final html commit between the two walks can never strand a wrap.
 * Fire-and-forget; errors never break rendering. */
export function linkBarePaths(container: ParentNode, options: LinkBarePathsOptions): void {
  void (async () => {
    try {
      const base = options.base.base
      const anchors = () => options.folders ? [...container.querySelectorAll<HTMLAnchorElement>("a[href]")] : []
      const parents = new Set<string>()
      const hrefs = [...walkHits(container).flatMap(hit => hit.candidates.map(candidate => candidate.href)),
        ...anchors().map(anchor => anchor.getAttribute("href") ?? "")]
      for (const href of hrefs) {
        const target = resolveTarget(href, base)
        if (target) parents.add(target.parent)
      }
      if (!parents.size || options.signal.aborted || !container.isConnected) return
      const listings = new Map(await Promise.all([...parents].map(async parent =>
        [parent, await directoryEntries(options.instanceId, options.base.directory, parent, { signal: options.signal })] as const)))
      if (options.signal.aborted || !container.isConnected) return
      const windows = /^[A-Za-z]:[\\/]/.test(base)
      const kindOf = (href: string) => {
        const target = resolveTarget(href, base)
        return target && entryKind(listings.get(target.parent), target.name, windows)
      }

      // Re-read the container: the markdown pipeline may have replaced its
      // children while the listings were in flight.
      let wrapped = false
      for (const { node, candidates } of walkHits(container)) {
        const matches = candidates
          .filter(candidate => { const kind = kindOf(candidate.href); return kind === "file" || (options.folders && kind === "directory") })
          .sort((left, right) => right.start - left.start)
        if (!matches.length) continue
        for (const candidate of matches) {
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
      for (const anchor of anchors()) {
        anchor.toggleAttribute(PROJECT_FOLDER_ATTRIBUTE, kindOf(anchor.getAttribute("href") ?? "") === "directory")
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
