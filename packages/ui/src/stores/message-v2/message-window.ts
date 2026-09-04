export const MESSAGE_WINDOW_PAGE_SIZE = 200
export const MAX_NEWER_CURSORS = 32

export type MessageWindowKind = "latest" | "history"
export type NewerCursor = string | null

export interface MessageWindowState {
  kind: MessageWindowKind
  resumeCursor?: string
  olderCursor?: string
  newerCursors: NewerCursor[]
}

export interface MessageWindowSnapshot {
  windowIsLatest?: boolean
  windowCursor?: string
  newerCursors?: NewerCursor[]
}

export function emptyLatestWindow(): MessageWindowState {
  return { kind: "latest", newerCursors: [] }
}

export function isLatestWindow(window?: MessageWindowState): boolean {
  return !window || window.kind === "latest"
}

export function windowFromSnapshot(snapshot?: MessageWindowSnapshot | null): MessageWindowState {
  const newerCursors = sanitizeNewerCursors(snapshot?.newerCursors)
  if (snapshot?.windowIsLatest === false || snapshot?.windowCursor) {
    return {
      kind: "history",
      resumeCursor: snapshot.windowCursor,
      newerCursors,
    }
  }
  return { kind: "latest", newerCursors }
}

export function planOlderWindow(current: MessageWindowState): { cursor: string; next: MessageWindowState } | null {
  if (!current.olderCursor) return null
  const pushed: NewerCursor = current.kind === "latest" ? null : current.resumeCursor ?? null
  const newerCursors = [...current.newerCursors, pushed]
  const truncated = hasTruncatedNewerPath(current.newerCursors) || newerCursors.length > MAX_NEWER_CURSORS
  const retainedCursors = hasTruncatedNewerPath(newerCursors) ? newerCursors.slice(2) : newerCursors
  return {
    cursor: current.olderCursor,
    next: {
      kind: "history",
      resumeCursor: current.olderCursor,
      newerCursors: truncated
        ? [null, null, ...retainedCursors.slice(-(MAX_NEWER_CURSORS - 2))]
        : newerCursors,
    },
  }
}

export function planNewerWindow(current: MessageWindowState): { cursor?: string; next: MessageWindowState; forward?: boolean; seekNewer?: string } | null {
  if (current.kind !== "history") return null
  if (hasTruncatedNewerPath(current.newerCursors) && current.newerCursors.length === 2 && current.resumeCursor) {
    return { next: current, seekNewer: current.resumeCursor }
  }
  if (current.newerCursors.length === 0) {
    return { next: emptyLatestWindow() }
  }
  const newerCursors = current.newerCursors.slice(0, -1)
  const popped = current.newerCursors[current.newerCursors.length - 1]
  if (popped === null) return { next: { kind: "latest", newerCursors } }
  const forward = !current.newerCursors.includes(null)
  return {
    cursor: popped,
    next: { kind: "history", resumeCursor: popped, newerCursors },
    ...(forward ? { forward: true } : {}),
  }
}

export function withOlderCursor(window: MessageWindowState, olderCursor?: string): MessageWindowState {
  return { ...window, olderCursor }
}

export function toWindowSnapshot(window: MessageWindowState): MessageWindowSnapshot {
  return {
    windowIsLatest: window.kind === "latest",
    windowCursor: window.resumeCursor,
    newerCursors: window.newerCursors,
  }
}

function sanitizeNewerCursors(cursors: readonly NewerCursor[] | undefined): NewerCursor[] {
  if (!cursors?.length) return []
  return cursors.slice(-MAX_NEWER_CURSORS)
}

function hasTruncatedNewerPath(cursors: readonly NewerCursor[]): boolean {
  return cursors[0] === null && cursors[1] === null
}
