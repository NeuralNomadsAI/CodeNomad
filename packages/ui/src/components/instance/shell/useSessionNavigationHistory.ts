import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import {
  EMPTY_SESSION_HISTORY,
  findSessionHistoryStep,
  moveSessionHistory,
  recordSessionVisit,
  type SessionHistoryDirection,
} from "../../../stores/session-navigation-history"

interface UseSessionNavigationHistoryOptions {
  activeSessionId: Accessor<string | null>
  isAvailable: (sessionId: string) => boolean
  select: (sessionId: string) => void
}

/** Records every conversation shown in this tab, whatever selected it, and
 * navigates it without pushing entries. Info and the draft are not entries. */
export function useSessionNavigationHistory(options: UseSessionNavigationHistoryOptions) {
  const [history, setHistory] = createSignal(EMPTY_SESSION_HISTORY)

  createEffect(() => {
    const sessionId = options.activeSessionId()
    if (!sessionId || sessionId === "info") return
    setHistory((current) => recordSessionVisit(current, sessionId))
  })

  const step = (direction: SessionHistoryDirection) =>
    findSessionHistoryStep(history(), direction, options.activeSessionId(), options.isAvailable)

  const canGoBack = createMemo(() => step(-1) !== null)
  const canGoForward = createMemo(() => step(1) !== null)

  const go = (direction: SessionHistoryDirection) => {
    const index = step(direction)
    if (index === null) return
    // Move the cursor first: the visit recorded for the selection then matches it.
    const next = moveSessionHistory(history(), index)
    setHistory(next)
    options.select(next.entries[index])
  }

  return {
    canGoBack,
    canGoForward,
    goBack: () => go(-1),
    goForward: () => go(1),
  }
}
