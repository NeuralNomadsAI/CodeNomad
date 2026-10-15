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
  // Snapshot restoration: anchor index/correction, pixel fallback, final mode.
  "restore-anchor", "restore-pixel", "restore-finish",
  // Escaped-reader retention and in-place reveals.
  "reader-settle", "align-element", "hold",
  // Layout compensation.
  "before-items", "viewport-resize",
  // Releases of Virtua's pending imperative/shift operation (scrollBy(0)).
  "cancel-virtua", "window-shift",
  // Mode-only sources.
  "user-gesture", "thumb-drag", "set-follow", "reset",
  // External writers retained to preserve occurrence-level/native reveal behavior.
  "search-reveal", "timeline-fallback",
] as const

export type ScrollReason = typeof SCROLL_REASONS[number]

export type ScrollTraceKind = "write" | "observe" | "mode"

const log = getLogger("scroll")

/** Zero cost while disabled: callers must check this before reading layout or building an entry. */
export function isScrollTraceEnabled() {
  return log.enabled
}

/** One JSON line per entry so console captures (DevTools, `codenomad.inspect`, tests) stay parseable. */
export function traceScroll(kind: ScrollTraceKind, entry: object) {
  log.log(`${kind} %j`, entry)
}
