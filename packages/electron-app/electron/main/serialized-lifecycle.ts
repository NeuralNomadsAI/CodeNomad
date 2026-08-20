export class SerializedLifecycle {
  private tail: Promise<void> = Promise.resolve()
  stopped = false

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.tail.catch(() => {}).then(operation)
    this.tail = queued.then(() => {}, () => {})
    return queued
  }

  stop<T>(operation: () => Promise<T>, interrupt?: () => void): Promise<T> {
    this.stopped = true
    interrupt?.()
    return this.enqueue(async () => {
      try {
        return await operation()
      } catch (error) {
        this.stopped = false
        throw error
      }
    })
  }
}
