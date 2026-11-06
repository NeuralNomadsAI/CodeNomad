/** One pass per key at a time; requests during a pass coalesce into a single
 * trailing pass. The returned promise settles after a pass that began after the request. */
export class TrailingResyncCoordinator {
  private readonly active = new Map<string, { dirty: boolean; settled: Promise<void>; controller: AbortController }>()

  constructor(
    private readonly run: (key: string, signal: AbortSignal) => Promise<void>,
    private readonly onError: (key: string, error: unknown) => void,
  ) {}

  request(key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    const existing = this.active.get(key)
    if (existing && !existing.controller.signal.aborted) {
      existing.dirty = true
      return existing.settled
    }
    const state = { dirty: true, settled: Promise.resolve(), controller: new AbortController() }
    const abort = () => {
      if (this.active.get(key) === state) this.active.delete(key)
      state.controller.abort()
    }
    signal?.addEventListener("abort", abort, { once: true })
    state.settled = Promise.resolve().then(async () => {
      try {
        while (state.dirty && !state.controller.signal.aborted) {
          state.dirty = false
          try {
            await this.run(key, state.controller.signal)
          } catch (error) {
            if (!state.controller.signal.aborted) this.onError(key, error)
          }
        }
      } finally {
        signal?.removeEventListener("abort", abort)
        if (this.active.get(key) === state) this.active.delete(key)
      }
    })
    this.active.set(key, state)
    return state.settled
  }
}

export async function waitForSettledPrerequisite(prerequisite: Promise<void> | undefined): Promise<void> {
  try {
    await prerequisite
  } catch {
    // A resync is the recovery path for a failed prerequisite.
  }
}
