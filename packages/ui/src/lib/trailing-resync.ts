export class TrailingResyncCoordinator {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(
    private readonly run: (key: string) => Promise<void>,
    private readonly onError: (key: string, error: unknown) => void,
  ) {}

  request(key: string): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const task = previous.then(async () => {
      try {
        await this.run(key)
      } catch (error) {
        this.onError(key, error)
      }
    })
    const tracked = task.finally(() => {
      if (this.tails.get(key) === tracked) this.tails.delete(key)
    })
    this.tails.set(key, tracked)
    return tracked
  }
}
