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

interface KeyState { timer?: ReturnType<typeof setTimeout>; due?: number; running: boolean; dirty?: RefreshUrgency; settledAt?: number;
  controller: AbortController; parent?: AbortSignal; release: () => void }

/**
 * Event-driven display revalidation: one timer and one in-flight run per key.
 * Invalidations are coalesced, never queued per event; an earlier due time wins
 * and later events never postpone it, so continuous activity cannot starve a
 * read. Demand arriving during a run reschedules once from its settlement. No
 * polling: without events nothing runs.
 */
export function createEventRefreshScheduler(run: (key: string, signal: AbortSignal) => Promise<unknown> | unknown, clock: {
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
} = {}) {
  const now = clock.now ?? Date.now
  const setTimer = clock.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = clock.clearTimer ?? (timer => clearTimeout(timer))
  const states = new Map<string, KeyState>()
  const cancel = (key: string, state = states.get(key)) => {
    if (!state || states.get(key) !== state) return
    states.delete(key)
    if (state.timer) clearTimer(state.timer)
    state.release()
    state.controller.abort()
  }

  const fire = (key: string, state: KeyState) => {
    if (states.get(key) !== state || state.controller.signal.aborted) return
    state.timer = undefined
    state.due = undefined
    state.running = true
    void Promise.resolve().then(() => {
      if (states.get(key) !== state || state.controller.signal.aborted) return
      return run(key, state.controller.signal)
    }).catch(() => undefined).finally(() => {
      if (states.get(key) !== state || state.controller.signal.aborted) return
      state.running = false
      state.settledAt = now()
      const dirty = state.dirty
      state.dirty = undefined
      if (dirty) schedule(key, dirty, state.parent)
    })
  }

  const schedule = (key: string, urgency: RefreshUrgency, signal?: AbortSignal): void => {
    if (signal?.aborted) return
    let state = states.get(key)
    if (state && state.parent !== signal) { cancel(key, state); state = states.get(key) }
    if (!state) {
      const owned: KeyState = { running: false, controller: new AbortController(), parent: signal, release: () => {} }
      const abort = () => cancel(key, owned)
      owned.release = () => signal?.removeEventListener("abort", abort)
      states.set(key, state = owned)
      signal?.addEventListener("abort", abort, { once: true })
    }
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
      cancel(key)
    },
  }
}
