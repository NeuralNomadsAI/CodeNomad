import { getLogger } from "../lib/logger"

/**
 * Closed set of authorities that move the transcript or change its follow mode.
 * Every VirtualFollowList position write names one; see `writeScroll`.
 */
export const SCROLL_REASONS = [
  // Explicit navigation and bottom pins.
  "jump-top", "jump-bottom", "jump-key", "explicit-pin",
  // Follow mode re-pinning after growth, or after an off-bottom observation.
  "content-grew", "observe",
  // Snapshot restoration: anchor row/correction, pixel fallback, final mode.
  "restore-anchor", "restore-pixel", "restore-finish",
  // Escaped-reader retention (including a jump's landing) and in-place reveals.
  "reader-settle", "align-element", "hold",
  // Layout compensation.
  "viewport-resize",
  // Mode-only sources.
  "user-gesture", "thumb-drag", "set-follow", "reset",
  // External writer retained to preserve occurrence-level reveal behavior.
  "search-reveal",
] as const

export type ScrollReason = typeof SCROLL_REASONS[number]

export type ScrollTraceKind = "write" | "observe" | "mode"
export type ScrollTraceEntry = { reason?: ScrollReason; source?: ScrollReason } & Record<string, unknown>

const log = getLogger("scroll")

/** Gate diagnostic layout reads and entry allocation; scroll operation objects still exist when disabled. */
export function isScrollTraceEnabled() {
  return log.enabled
}

/** One JSON line per entry so console captures (DevTools, `codenomad.inspect`, tests) stay parseable. */
export function traceScroll(kind: ScrollTraceKind, entry: ScrollTraceEntry) {
  log.log(`${kind} %j`, entry)
}
