/**
 * Browser-like history of the conversations visited in one project tab.
 * Pure state transitions; the shell owns one instance per mounted tab, so the
 * history stays in memory for that window and is never persisted.
 */
export const SESSION_HISTORY_LIMIT = 50

export interface SessionHistoryState {
  readonly entries: readonly string[]
  /** Cursor into `entries`; -1 while empty. */
  readonly index: number
}

export type SessionHistoryDirection = -1 | 1

export const EMPTY_SESSION_HISTORY: SessionHistoryState = { entries: [], index: -1 }

/** A visit after going back truncates the forward stack, like a browser. */
export function recordSessionVisit(
  state: SessionHistoryState,
  sessionId: string,
  limit = SESSION_HISTORY_LIMIT,
): SessionHistoryState {
  if (state.entries[state.index] === sessionId) return state
  const entries = [...state.entries.slice(0, state.index + 1), sessionId]
  const dropped = Math.max(0, entries.length - limit)
  return { entries: entries.slice(dropped), index: entries.length - 1 - dropped }
}

/**
 * Index of the nearest usable entry in `direction`, skipping deleted or
 * otherwise unavailable sessions and the one already shown. When the shell
 * shows something that is not the cursor entry (Info, the no-session draft),
 * Back first returns to the cursor entry itself.
 */
export function findSessionHistoryStep(
  state: SessionHistoryState,
  direction: SessionHistoryDirection,
  currentSessionId: string | null,
  isAvailable: (sessionId: string) => boolean,
): number | null {
  const onCursor = currentSessionId !== null && state.entries[state.index] === currentSessionId
  let index = direction < 0 && !onCursor ? state.index : state.index + direction
  for (; index >= 0 && index < state.entries.length; index += direction) {
    const sessionId = state.entries[index]
    if (sessionId !== currentSessionId && isAvailable(sessionId)) return index
  }
  return null
}

export function moveSessionHistory(state: SessionHistoryState, index: number): SessionHistoryState {
  return index === state.index ? state : { entries: state.entries, index }
}
