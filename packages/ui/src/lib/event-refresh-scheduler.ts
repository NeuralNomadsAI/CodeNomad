export type RefreshUrgency = "urgent" | "activity"

/** Short coalescing window for urgent invalidations (journal changes, reconnects). */
export const EVENT_REFRESH_DEBOUNCE_MS = 50
/** Native activity of a large running family arrives continuously; display
 * revalidation waits this long after the previous read settled. */
export const ACTIVITY_REFRESH_INTERVAL_MS = 5_000

/** Earliest start for an invalidation, given when the previous read settled. */
export function eventRefreshDue(urgency: RefreshUrgency, now: number, settledAt: number | undefined): number {
  const due = now + EVENT_REFRESH_DEBOUNCE_MS
  return urgency === "activity" && settledAt !== undefined ? Math.max(due, settledAt + ACTIVITY_REFRESH_INTERVAL_MS) : due
}

interface KeyState { timer?: ReturnType<typeof setTimeout>; due?: number; running: boolean; dirty?: RefreshUrgency; settledAt?: number }

/**
 * Event-driven display revalidation: one timer and one in-flight run per key.
 * Invalidations are coalesced, never queued per event; an earlier due time wins
 * and later events never postpone it, so continuous activity cannot starve a
 * read. Demand arriving during a run reschedules once from its settlement. No
 * polling: without events nothing runs.
 */
export function createEventRefreshScheduler(run: (key: string) => Promise<unknown> | unknown, clock: {
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
} = {}) {
  const now = clock.now ?? Date.now
  const setTimer = clock.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = clock.clearTimer ?? (timer => clearTimeout(timer))
  const states = new Map<string, KeyState>()

  const fire = (key: string, state: KeyState) => {
    state.timer = undefined
    state.due = undefined
    state.running = true
    void Promise.resolve().then(() => run(key)).catch(() => undefined).finally(() => {
      state.running = false
      state.settledAt = now()
      const dirty = state.dirty
      state.dirty = undefined
      if (dirty && states.get(key) === state) schedule(key, dirty)
    })
  }

  const schedule = (key: string, urgency: RefreshUrgency): void => {
    let state = states.get(key)
    if (!state) states.set(key, state = { running: false })
    if (state.running) {
      if (state.dirty !== "urgent") state.dirty = urgency
      return
    }
    const due = eventRefreshDue(urgency, now(), state.settledAt)
    if (state.timer && state.due! <= due) return
    if (state.timer) clearTimer(state.timer)
    const current = state
    state.due = due
    state.timer = setTimer(() => fire(key, current), due - now())
  }

  return {
    schedule,
    /** Forget pending demand; an in-flight run settles without rescheduling. */
    cancel(key: string): void {
      const state = states.get(key)
      if (state?.timer) clearTimer(state.timer)
      states.delete(key)
    },
  }
}
