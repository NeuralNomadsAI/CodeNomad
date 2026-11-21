/** One pass per key at a time; requests during a pass coalesce into a single
 * trailing pass. The returned promise settles after a pass that began after the request.
 * A failed pass is requested again after each of `retryDelaysMs` in turn; a request
 * while a retry waits runs at once, a successful pass restores the whole budget and
 * `cancel` drops a waiting retry. */
export class TrailingResyncCoordinator {
  private readonly active = new Map<string, { dirty: boolean; settled: Promise<void>; controller: AbortController; parent?: AbortSignal }>()
  private readonly retries = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout>; release?: () => void; parent?: AbortSignal }>()

  constructor(
    private readonly run: (key: string, signal: AbortSignal) => Promise<void>,
    private readonly onError: (key: string, error: unknown) => void,
    private readonly retryDelaysMs: readonly number[] = [],
  ) {}

  request(key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    let retry = this.retries.get(key)
    if (retry && retry.parent !== signal) {
      this.cancel(key)
      retry = undefined
    }
    if (retry?.timer) {
      clearTimeout(retry.timer)
      retry.timer = undefined
      retry.release?.()
      retry.release = undefined
    }
    const existing = this.active.get(key)
    if (existing && existing.parent === signal && !existing.controller.signal.aborted) {
      existing.dirty = true
      return existing.settled
    }
    existing?.controller.abort()
    const state = { dirty: true, settled: Promise.resolve(), controller: new AbortController(), parent: signal }
    const abort = () => {
      if (this.active.get(key) === state) this.active.delete(key)
      state.controller.abort()
    }
    signal?.addEventListener("abort", abort, { once: true })
    state.settled = Promise.resolve().then(async () => {
      let failed = false
      try {
        while (state.dirty && !state.controller.signal.aborted) {
          state.dirty = false
          try {
            await this.run(key, state.controller.signal)
            failed = false
          } catch (error) {
            if (!state.controller.signal.aborted) {
              failed = true
              this.onError(key, error)
            }
          }
        }
      } finally {
        signal?.removeEventListener("abort", abort)
        if (this.active.get(key) === state) {
          this.active.delete(key)
          if (failed && !state.controller.signal.aborted) this.scheduleRetry(key, signal)
          else this.cancel(key)
        }
      }
    })
    this.active.set(key, state)
    return state.settled
  }

  cancel(key: string): void {
    const retry = this.retries.get(key)
    clearTimeout(retry?.timer)
    retry?.release?.()
    this.retries.delete(key)
  }

  private scheduleRetry(key: string, signal?: AbortSignal): void {
    if (signal?.aborted) { this.cancel(key); return }
    const retry = this.retries.get(key) ?? { attempt: 0, parent: signal }
    const delay = this.retryDelaysMs[retry.attempt]
    if (delay === undefined) {
      this.retries.delete(key)
      return
    }
    retry.attempt += 1
    const abort = () => { if (this.retries.get(key) === retry) this.cancel(key) }
    signal?.addEventListener("abort", abort, { once: true })
    retry.release = () => signal?.removeEventListener("abort", abort)
    retry.timer = setTimeout(() => {
      retry.timer = undefined
      retry.release?.()
      retry.release = undefined
      if (this.retries.get(key) === retry) void this.request(key, signal)
    }, delay)
    this.retries.set(key, retry)
  }
}

export async function waitForSettledPrerequisite(prerequisite: Promise<void> | undefined): Promise<void> {
  try {
    await prerequisite
  } catch {
    // A resync is the recovery path for a failed prerequisite.
  }
}
