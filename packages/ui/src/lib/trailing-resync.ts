/** One pass per key at a time; requests during a pass coalesce into a single
 * trailing pass. The returned promise settles after a pass that began after the request.
 * A failed pass is requested again after each of `retryDelaysMs` in turn; a request
 * while a retry waits runs at once, a successful pass restores the whole budget and
 * `cancel` drops a waiting retry. */
export class TrailingResyncCoordinator {
  private readonly active = new Map<string, { dirty: boolean; settled: Promise<void> }>()
  private readonly retries = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>()

  constructor(
    private readonly run: (key: string) => Promise<void>,
    private readonly onError: (key: string, error: unknown) => void,
    private readonly retryDelaysMs: readonly number[] = [],
  ) {}

  request(key: string): Promise<void> {
    const retry = this.retries.get(key)
    if (retry?.timer) {
      clearTimeout(retry.timer)
      retry.timer = undefined
    }
    const existing = this.active.get(key)
    if (existing) {
      existing.dirty = true
      return existing.settled
    }
    const state = { dirty: true, settled: Promise.resolve() }
    state.settled = Promise.resolve().then(async () => {
      let failed = false
      try {
        while (state.dirty) {
          state.dirty = false
          try {
            await this.run(key)
            failed = false
          } catch (error) {
            failed = true
            this.onError(key, error)
          }
        }
      } finally {
        this.active.delete(key)
        if (failed) this.scheduleRetry(key)
        else this.retries.delete(key)
      }
    })
    this.active.set(key, state)
    return state.settled
  }

  cancel(key: string): void {
    clearTimeout(this.retries.get(key)?.timer)
    this.retries.delete(key)
  }

  private scheduleRetry(key: string): void {
    const retry = this.retries.get(key) ?? { attempt: 0 }
    const delay = this.retryDelaysMs[retry.attempt]
    if (delay === undefined) {
      this.retries.delete(key)
      return
    }
    retry.attempt += 1
    retry.timer = setTimeout(() => {
      retry.timer = undefined
      void this.request(key)
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
