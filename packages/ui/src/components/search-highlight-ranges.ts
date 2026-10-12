import type { SessionSearchMatch } from "../lib/session-search"

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

/** Reveal the actual occurrence through nested code/tool and transcript scrollers, up to `boundary` when given. */
export function revealSearchRange(range: Range, boundary?: HTMLElement): void {
  const node = range.startContainer
  if (!node.isConnected) return
  const document = node.ownerDocument!
  for (let parent = node.parentElement; parent; parent = parent === boundary ? null : parent.parentElement) {
    const style = document.defaultView!.getComputedStyle(parent)
    const rect = range.getBoundingClientRect(), bounds = parent.getBoundingClientRect()
    const top = bounds.top + parent.clientTop, left = bounds.left + parent.clientLeft
    const vertical = parent.scrollHeight > parent.clientHeight && (/auto|scroll|overlay/.test(style.overflowY) || parent === document.scrollingElement)
    const horizontal = parent.scrollWidth > parent.clientWidth && /auto|scroll|overlay/.test(style.overflowX)
    if (vertical && (rect.top < top || rect.bottom > top + parent.clientHeight)) {
      parent.scrollTop += (rect.top + rect.bottom) / 2 - top - parent.clientHeight / 2
    }
    if (horizontal && (rect.left < left || rect.right > left + parent.clientWidth)) {
      parent.scrollLeft += rect.left < left ? rect.left - left : rect.right - left - parent.clientWidth
    }
  }
}
