export const SESSION_MESSAGE_WINDOW_LIMIT = 200

export interface MessageWindowState {
  cursor?: string
  olderCursor?: string
  newerCursors: (string | null)[]
}

export function latestMessageWindow(): MessageWindowState {
  return { newerCursors: [] }
}

export function restoreMessageWindow(snapshot?: { windowCursor?: string; newerCursors?: (string | null)[] }): MessageWindowState {
  return {
    cursor: snapshot?.windowCursor,
    newerCursors: snapshot?.newerCursors?.filter((cursor) => cursor === null || typeof cursor === "string") ?? [],
  }
}

export function planOlderMessageWindow(current: MessageWindowState): MessageWindowState | null {
  if (!current.olderCursor) return null
  return { cursor: current.olderCursor, newerCursors: [...current.newerCursors, current.cursor ?? null] }
}

export function planNewerMessageWindow(current: MessageWindowState): MessageWindowState | null {
  if (current.cursor === undefined) return null
  const cursor = current.newerCursors.at(-1)
  return cursor === undefined || cursor === null
    ? latestMessageWindow()
    : { cursor, newerCursors: current.newerCursors.slice(0, -1) }
}

export function completeMessageWindow(window: MessageWindowState, olderCursor?: string): MessageWindowState {
  return { ...window, olderCursor }
}

export function preserveMessageWindowCursor<T extends object>(
  snapshot: T,
  current: { windowCursor?: string; newerCursors?: (string | null)[] } | undefined,
  window: MessageWindowState | undefined,
): T & { windowCursor?: string; newerCursors?: (string | null)[] } {
  return {
    ...snapshot,
    windowCursor: window ? window.cursor : current?.windowCursor,
    newerCursors: window ? window.newerCursors : current?.newerCursors,
  }
}
