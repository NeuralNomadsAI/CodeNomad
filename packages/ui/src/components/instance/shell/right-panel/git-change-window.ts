import { createMemo, createSignal, type Accessor } from "solid-js"
import type { GitChangeListItem, GitChangeSection } from "./types"

/** Rows a Changes section renders initially, and how many more each reveal adds. */
export const GIT_CHANGE_ROW_LIMIT = 200

export interface GitChangeWindow {
  /** The first `limit` rows, then pinned rows beyond them, in list order. */
  rows: GitChangeListItem[]
  total: number
  hidden: number
  /** Rows the next reveal renders, the limit that renders them and the first of them. */
  nextReveal: number
  nextLimit: number
  firstHiddenId: string | null
}

/**
 * Bounds a section to its first `limit` rows. Pinned rows (`stickyPins`) beyond
 * the bound still render after them, so a selection is never unreachable without
 * growing the window to its index.
 */
export function buildGitChangeWindow(items: GitChangeListItem[], limit: number, pinned: ReadonlySet<string>): GitChangeWindow {
  if (items.length <= limit) return { rows: items, total: items.length, hidden: 0, nextReveal: 0, nextLimit: limit, firstHiddenId: null }
  const rows = items.slice(0, limit)
  let nextReveal = 0, nextLimit = limit, firstHiddenId: string | null = null
  for (let index = limit; index < items.length; index++) {
    const item = items[index]
    if (pinned.has(item.id)) rows.push(item)
    else if (nextReveal < GIT_CHANGE_ROW_LIMIT) {
      nextReveal += 1
      nextLimit = index + 1
      firstHiddenId ??= item.id
    }
  }
  return { rows, total: items.length, hidden: items.length - rows.length, nextReveal, nextLimit, firstHiddenId }
}

export function sameGitChangeWindow(a: GitChangeWindow, b: GitChangeWindow): boolean {
  return a.total === b.total && a.hidden === b.hidden && a.nextReveal === b.nextReveal && a.nextLimit === b.nextLimit
    && a.firstHiddenId === b.firstHiddenId && a.rows.length === b.rows.length && a.rows.every((row, index) => row === b.rows[index])
}

/**
 * Pins are sticky: every id pinned once (current, previewed or bulk-selected)
 * stays pinned while it remains in the inventory. Grows only through user
 * selection; returns `previous` itself when membership is unchanged.
 */
export function stickyPins(previous: ReadonlySet<string>, pinned: ReadonlySet<string>, present: ReadonlySet<string>): ReadonlySet<string> {
  const next = new Set<string>()
  for (const id of previous) if (present.has(id)) next.add(id)
  for (const id of pinned) if (present.has(id)) next.add(id)
  return next.size === previous.size && Array.from(next).every(id => previous.has(id)) ? previous : next
}

const initialLimits = (): Record<GitChangeSection, number> => ({ staged: GIT_CHANGE_ROW_LIMIT, unstaged: GIT_CHANGE_ROW_LIMIT })

/**
 * Per-section bounded windows. Reveals and sticky pins persist across refreshes
 * until `reset`, so a row shown beyond the bound never disappears because its
 * preview closed, the selection moved or focus left it; only leaving the
 * inventory or a reset removes it.
 */
export function createGitChangeWindows(items: Accessor<GitChangeListItem[]>, pinned: Accessor<ReadonlySet<string>>) {
  const [limits, setLimits] = createSignal(initialLimits())
  const [generation, setGeneration] = createSignal(0)
  const present = createMemo(() => new Set(items().map(item => item.id)))
  let pinsGeneration = 0
  const pins = createMemo<ReadonlySet<string>>(previous => {
    const current = generation()
    const kept = current === pinsGeneration ? previous : new Set<string>()
    pinsGeneration = current
    return stickyPins(kept, pinned(), present())
  }, new Set())
  const window = (section: GitChangeSection) => createMemo(() =>
    buildGitChangeWindow(items().filter(item => item.section === section), limits()[section], pins()), undefined, { equals: sameGitChangeWindow })
  const windows = { staged: window("staged"), unstaged: window("unstaged") }
  return {
    window: (section: GitChangeSection) => windows[section](),
    /** Rendered rows in document order: selection ranges never span rows the user cannot see. */
    rendered: () => [...windows.staged().rows, ...windows.unstaged().rows],
    reveal: (section: GitChangeSection) => setLimits(current => ({ ...current, [section]: windows[section]().nextLimit })),
    reset: () => { setLimits(initialLimits()); setGeneration(value => value + 1) },
  }
}
