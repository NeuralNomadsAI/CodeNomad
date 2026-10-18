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
 * Bounds a section to its first `limit` rows. Pinned rows (current, previewed,
 * bulk-selected) beyond the bound still render after them, so a selection is
 * never unreachable without growing the window to its index.
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

const initialLimits = (): Record<GitChangeSection, number> => ({ staged: GIT_CHANGE_ROW_LIMIT, unstaged: GIT_CHANGE_ROW_LIMIT })

/** Per-section bounded windows; reveals persist across refreshes until `reset`. */
export function createGitChangeWindows(items: Accessor<GitChangeListItem[]>, pinned: Accessor<ReadonlySet<string>>) {
  const [limits, setLimits] = createSignal(initialLimits())
  // The row holding keyboard focus stays rendered until focus leaves it, so
  // closing its preview or deselecting it from inside never drops focus.
  const [focused, setFocused] = createSignal<string | null>(null)
  const pins = createMemo(() => {
    const id = focused(), base = pinned()
    return !id || base.has(id) ? base : new Set(base).add(id)
  })
  const window = (section: GitChangeSection) => createMemo(() =>
    buildGitChangeWindow(items().filter(item => item.section === section), limits()[section], pins()), undefined, { equals: sameGitChangeWindow })
  const windows = { staged: window("staged"), unstaged: window("unstaged") }
  return {
    window: (section: GitChangeSection) => windows[section](),
    /** Rendered rows in document order: selection ranges never span rows the user cannot see. */
    rendered: () => [...windows.staged().rows, ...windows.unstaged().rows],
    reveal: (section: GitChangeSection) => setLimits(current => ({ ...current, [section]: windows[section]().nextLimit })),
    /** Holds (`true`) or releases this row's focus pin; a release never clears another row's hold. */
    holdFocus: (id: string, held: boolean) => setFocused(current => held ? id : current === id ? null : current),
    reset: () => { setLimits(initialLimits()); setFocused(null) },
  }
}
