/**
 * Minimum visible duration helper.
 *
 * Wraps an async `work` promise so the resolved/rejected promise it returns
 * never settles earlier than `minMs` after invocation. This is used to keep
 * short-lived spinners visible long enough for the user to perceive them,
 * even when the underlying work resolves in the same microtask (e.g. cached
 * loads, dedupe early-returns, localhost dev servers).
 *
 * The minimum-duration guard applies to BOTH success and failure paths: a
 * failed reload should still show the spinner long enough to be perceptible
 * before any error toast replaces it.
 *
 * The `now` and `delay` dependencies are injectable so the helper can be
 * unit-tested deterministically without sleeping real time. By default they
 * use `Date.now()` and `setTimeout`.
 *
 * Concurrent invocations on the same caller-supplied `work` promise are
 * intentionally not de-duped here; the caller controls scheduling. This
 * helper is a thin timing wrapper, nothing more.
 */

/**
 * Default minimum visible duration for the session-list reload spinner, in
 * milliseconds. Tuned to feel responsive but visible — values under ~400ms
 * tend to feel like a flicker.
 */
export const MIN_RELOAD_SPINNER_MS = 450

export interface WithMinimumDurationDeps {
  /** Returns the current timestamp in milliseconds. Defaults to `Date.now`. */
  now?: () => number
  /** Resolves after the given number of milliseconds. Defaults to `setTimeout`. */
  delay?: (ms: number) => Promise<void>
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Returns a promise that mirrors `work`'s outcome (value or error) but is
 * guaranteed not to settle before `minMs` have elapsed since the call.
 *
 * When `work` resolves before `minMs`, the result is held until `minMs` is
 * reached. When `work` resolves after `minMs`, the result is forwarded
 * immediately. The same applies to rejections.
 */
export async function withMinimumDuration<T>(
  work: Promise<T>,
  minMs: number,
  deps?: WithMinimumDurationDeps,
): Promise<T> {
  const now = deps?.now ?? Date.now
  const delay = deps?.delay ?? defaultDelay

  // Guard against pathological inputs — never delay if asked for a
  // non-positive minimum.
  if (!(minMs > 0)) {
    return work
  }

  const startedAt = now()

  // Settle the work and the elapsed-time guard independently so the wrapper
  // mirrors the work's outcome (value or error) while still enforcing the
  // floor on perceived duration.
  let workValue: T
  let workError: unknown
  let workSucceeded = false

  try {
    workValue = await work
    workSucceeded = true
  } catch (error) {
    workError = error
  }

  const elapsed = now() - startedAt
  const remaining = minMs - elapsed
  if (remaining > 0) {
    await delay(remaining)
  }

  if (workSucceeded) {
    return workValue!
  }
  throw workError
}
