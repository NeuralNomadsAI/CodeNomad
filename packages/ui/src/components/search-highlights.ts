import type { SessionSearchMatch } from "../lib/session-search"
import { collectSearchRanges, revealSearchRange, type AlignInTranscript, type SearchRange } from "./search-highlight-ranges"
import { paintSearchMarks } from "./search-highlight-marks"

/** One navigation's reveal of its active occurrence; the first row to reveal it claims it. */
export interface SearchRevealRequest { matchId: string; claimed: boolean }

const MATCHES = "codenomad-search"
const ACTIVE = "codenomad-search-active"
interface DocumentHighlights { matches: Highlight; active: Highlight; owners: number }
interface Owner {
  ranges: SearchRange[]
  marks: HTMLElement[]
  documentHighlights?: DocumentHighlights
  observer?: MutationObserver
  frame?: number
  scrollFrame?: number
}
const documents = new WeakMap<Document, DocumentHighlights>()
const owners = new WeakMap<HTMLElement, Owner>()

/**
 * A virtualizer that moves a row (removing and reinserting an ancestor)
 * collapses the row's live ranges without mutating the row. One observer per
 * document watches the rows' ancestors, up to their transcript, and repaints
 * each reinserted row at once, before the next paint.
 */
interface RowMoves { observer: MutationObserver; repaints: Map<HTMLElement, () => void> }
const rowMoves = new WeakMap<Document, RowMoves>()

function watchRowMoves(root: HTMLElement, repaint: () => void) {
  const document = root.ownerDocument
  let moves = rowMoves.get(document)
  if (!moves) {
    const repaints = new Map<HTMLElement, () => void>()
    const observer = new document.defaultView!.MutationObserver((records) => {
      const moved = new Set<HTMLElement>()
      for (const record of records) for (const node of record.addedNodes) {
        if (!node.hasChildNodes()) continue
        for (const row of repaints.keys()) if (node.contains(row)) moved.add(row)
      }
      for (const row of moved) repaints.get(row)?.()
    })
    moves = { observer, repaints }
    rowMoves.set(document, moves)
  }
  moves.repaints.set(root, repaint)
  const transcript = root.closest(".message-stream")
  for (let parent = root.parentElement; parent; parent = parent === transcript ? null : parent.parentElement) {
    moves.observer.observe(parent, { childList: true })
  }
}

function unwatchRowMoves(root: HTMLElement) {
  const moves = rowMoves.get(root.ownerDocument)
  if (!moves?.repaints.delete(root) || moves.repaints.size > 0) return
  moves.observer.disconnect()
  rowMoves.delete(root.ownerDocument)
}

function registry(document: Document): DocumentHighlights | undefined {
  const view = document.defaultView as (Window & typeof globalThis) | null
  if (!view?.Highlight || !view.CSS?.highlights) return
  let value = documents.get(document)
  if (!value) {
    value = { matches: new view.Highlight(), active: new view.Highlight(), owners: 0 }
    value.active.priority = 1
    documents.set(document, value)
    view.CSS.highlights.set(MATCHES, value.matches)
    view.CSS.highlights.set(ACTIVE, value.active)
  }
  value.owners++
  return value
}

function unpaint(owner: Owner) {
  for (const { range } of owner.ranges) {
    owner.documentHighlights?.matches.delete(range)
    owner.documentHighlights?.active.delete(range)
  }
  owner.ranges = []
  for (const mark of owner.marks) {
    const parent = mark.parentNode
    if (!parent) continue
    mark.replaceWith(mark.ownerDocument.createTextNode(mark.textContent ?? ""))
    parent.normalize()
  }
  owner.marks = []
}

export function clearSearchHighlights(root: HTMLElement): void {
  const owner = owners.get(root)
  if (!owner) return
  owners.delete(root)
  owner.observer?.disconnect()
  unwatchRowMoves(root)
  const view = root.ownerDocument.defaultView!
  if (owner.frame !== undefined) view.cancelAnimationFrame(owner.frame)
  if (owner.scrollFrame !== undefined) view.cancelAnimationFrame(owner.scrollFrame)
  unpaint(owner)
  const value = owner.documentHighlights
  if (value && --value.owners === 0) {
    const highlights = (view as Window & typeof globalThis).CSS.highlights
    if (highlights.get(MATCHES) === value.matches) highlights.delete(MATCHES)
    if (highlights.get(ACTIVE) === value.active) highlights.delete(ACTIVE)
    documents.delete(root.ownerDocument)
  }
}

/**
 * One mounted message owns its contribution; another row cannot clear it.
 * `reveal` scrolls the active occurrence into view once, through `align` for
 * the transcript itself.
 */
export function applySearchHighlights(root: HTMLElement, query: string, active?: SessionSearchMatch | null, reveal?: SearchRevealRequest, align?: AlignInTranscript): void {
  clearSearchHighlights(root)
  if (!query.trim()) return
  const view = root.ownerDocument.defaultView!
  const owner: Owner = { ranges: [], marks: [], documentHighlights: registry(root.ownerDocument) }
  owners.set(root, owner)

  const paint = () => {
    if (owners.get(root) !== owner) return
    if (owner.frame !== undefined) view.cancelAnimationFrame(owner.frame)
    owner.frame = undefined
    if (owner.scrollFrame !== undefined) view.cancelAnimationFrame(owner.scrollFrame)
    owner.scrollFrame = undefined
    owner.observer?.disconnect()
    unpaint(owner)
    owner.ranges = collectSearchRanges(root, query, active)
    let activeRange: Range | undefined
    if (owner.documentHighlights) {
      for (const item of owner.ranges) {
        owner.documentHighlights.matches.add(item.range)
        if (item.active) { owner.documentHighlights.active.add(item.range); activeRange = item.range }
      }
    } else {
      const painted = paintSearchMarks(owner.ranges)
      owner.marks = painted.marks
      activeRange = painted.activeRange
      owner.ranges = []
    }
    if (reveal && !reveal.claimed && activeRange) {
      owner.scrollFrame = view.requestAnimationFrame(() => {
        owner.scrollFrame = undefined
        // A moved row collapses its live ranges; its repaint reveals instead.
        if (owners.get(root) === owner && !reveal.claimed && !activeRange!.collapsed && activeRange!.startContainer.isConnected) {
          reveal.claimed = true
          revealSearchRange(activeRange!, align)
        }
      })
    }
    owner.observer?.observe(root, { childList: true, characterData: true, subtree: true })
    watchRowMoves(root, paint)
  }

  // Markdown and lazy tool renderers can commit after the record's effect.
  // Observe DOM replacement, not style/paint changes; coalesce streaming work.
  owner.observer = new view.MutationObserver(() => {
    if (owner.frame !== undefined) return
    owner.frame = view.requestAnimationFrame(() => {
      owner.frame = undefined
      if (root.isConnected) paint()
      else clearSearchHighlights(root)
    })
  })
  paint()
}
