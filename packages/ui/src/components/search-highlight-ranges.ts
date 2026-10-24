import { scrollAxes } from "../lib/scroll-gesture-routing"
import type { SessionSearchMatch } from "../lib/session-search"
import { isScrollTraceEnabled, traceScroll } from "./virtual-scroll-trace"

export interface SearchRange { range: Range; active: boolean }

// Offsets normally map directly. Expanding case folds (e.g. İ -> i + dot)
// require mapping back to UTF-16 boundaries in the original text.
function originalOffset(text: string, folded: string, offset: number, end: boolean): number {
  if (text.length === folded.length) return offset
  // Search prefix lengths rather than folding every preceding prefix for every hit.
  let low = 0, high = text.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (text.slice(0, middle).toLocaleLowerCase().length < offset) low = middle + 1
    else high = middle
  }
  if (!end && text.slice(0, low).toLocaleLowerCase().length > offset) low--
  // Never cut through a surrogate pair when mapping an expanded fold.
  if (low > 0 && /[\uDC00-\uDFFF]/.test(text[low] ?? "") && /[\uD800-\uDBFF]/.test(text[low - 1])) low += end ? 1 : -1
  return low
}

export function collectSearchRanges(root: HTMLElement, query: string, active?: SessionSearchMatch | null): SearchRange[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  const document = root.ownerDocument
  const seen = new Set<Node>()
  const result: SearchRange[] = []
  let occurrence = 0
  for (const container of root.querySelectorAll<HTMLElement>(".message-text, .tool-call, .message-reasoning-text")) {
    const partId = (container.closest<HTMLElement>("[data-part-id]") ?? container).dataset.partId
    const inActivePart = Boolean(active) && (!active?.partId || active.partId === partId)
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (seen.has(node)) continue
      seen.add(node)
      if (!node.parentElement || node.parentElement.closest("button, input, textarea, select")) continue
      const text = node.nodeValue ?? "", folded = text.toLocaleLowerCase()
      for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + needle.length)) {
        const range = document.createRange()
        range.setStart(node, originalOffset(text, folded, at, false))
        range.setEnd(node, originalOffset(text, folded, at + needle.length, true))
        result.push({ range, active: Boolean(inActivePart && active && occurrence === active.occurrence) })
        if (inActivePart) occurrence++
      }
    }
  }
  return result
}

/** Holds `target` `viewportOffset` px below the transcript top through the list that owns its position. */
export type AlignInTranscript = (target: HTMLElement, viewportOffset: number) => void

/**
 * Reveal the actual occurrence through nested code/tool scrollers, then the
 * transcript, centring it in each scroller that leaves it out of view. The
 * walk stops at the transcript. With `align`, the transcript's list holds the
 * occurrence's element at its centred offset through its own `writeScroll`
 * (`align-element`): a direct write would be undone by the list's placement
 * corrections after a jump. That offset cannot be negative, so an occurrence
 * more than half a viewport below the top of its element lands with that
 * element at the top, possibly still out of view. The alignment re-measures
 * that element for 30 frames, and a wheel consumed by a nested scroller is not
 * a list gesture: scrolling such a scroller during that window moves the
 * transcript along with the element. Known follow-up: the reveal runs one frame
 * after the row's highlights are painted, so that frame can show the message
 * top. Nested scrollers, and a
 * transcript outside a list, are written directly and traced as `search-reveal`.
 */
export function revealSearchRange(range: Range, align?: AlignInTranscript): void {
  const node = range.startContainer
  if (!node.isConnected) return
  const document = node.ownerDocument!
  const transcript = node.parentElement?.closest(".message-stream")
  for (let parent = node.parentElement; parent; parent = parent === transcript ? null : parent.parentElement) {
    const axes = scrollAxes(parent)
    const rect = range.getBoundingClientRect(), bounds = parent.getBoundingClientRect()
    const top = bounds.top + parent.clientTop, left = bounds.left + parent.clientLeft
    const vertical = axes.y || (parent === document.scrollingElement && parent.scrollHeight > parent.clientHeight)
    const horizontal = axes.x
    if (vertical && (rect.top < top || rect.bottom > top + parent.clientHeight)) {
      const delta = (rect.top + rect.bottom) / 2 - top - parent.clientHeight / 2
      const target = node.parentElement!
      if (parent === transcript && align) align(target, target.getBoundingClientRect().top - top - delta)
      else {
        const from = isScrollTraceEnabled() ? parent.scrollTop : undefined
        parent.scrollTop += delta
        if (from !== undefined && Math.abs(parent.scrollTop - from) >= 1) traceScroll("write", {
          reason: "search-reveal", writer: "external", from, to: parent.scrollTop,
          mode: parent.dataset.followMode, transcript: parent === transcript,
          key: node.parentElement?.closest<HTMLElement>("[data-virtual-follow-key]")?.dataset.virtualFollowKey,
          at: Math.round(performance.now()),
        })
      }
    }
    if (horizontal && (rect.left < left || rect.right > left + parent.clientWidth)) {
      parent.scrollLeft += rect.left < left ? rect.left - left : rect.right - left - parent.clientWidth
    }
  }
}
