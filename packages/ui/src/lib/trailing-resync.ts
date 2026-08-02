export class TrailingResyncCoordinator {
  private readonly active = new Map<string, { dirty: boolean; promise: Promise<void> }>()

  constructor(
    private readonly run: (key: string) => Promise<void>,
    private readonly onError: (key: string, error: unknown) => void,
  ) {}

  request(key: string): Promise<void> {
    const existing = this.active.get(key)
    if (existing) {
      existing.dirty = true
      return existing.promise
    }

    const state = { dirty: false, promise: undefined as unknown as Promise<void> }
    this.active.set(key, state)
    state.promise = (async () => {
      do {
        state.dirty = false
        try {
          await this.run(key)
        } catch (error) {
          this.onError(key, error)
        }
      } while (state.dirty)
    })().finally(() => {
      if (this.active.get(key) === state) this.active.delete(key)
    })
    return state.promise
  }
}

export async function waitForSettledPrerequisite(prerequisite: Promise<void> | undefined): Promise<void> {
  try {
    await prerequisite
  } catch {
    // A resync is the recovery path for a failed prerequisite.
  }
}
