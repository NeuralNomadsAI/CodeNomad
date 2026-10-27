/** One pass per key at a time; requests during a pass coalesce into a single
 * trailing pass. The returned promise settles after a pass that began after the request. */
export class TrailingResyncCoordinator {
  private readonly active = new Map<string, { dirty: boolean; settled: Promise<void> }>()

  constructor(
    private readonly run: (key: string) => Promise<void>,
    private readonly onError: (key: string, error: unknown) => void,
  ) {}

  request(key: string): Promise<void> {
    const existing = this.active.get(key)
    if (existing) {
      existing.dirty = true
      return existing.settled
    }
    const state = { dirty: true, settled: Promise.resolve() }
    state.settled = Promise.resolve().then(async () => {
      try {
        while (state.dirty) {
          state.dirty = false
          try {
            await this.run(key)
          } catch (error) {
            this.onError(key, error)
          }
        }
      } finally {
        this.active.delete(key)
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
