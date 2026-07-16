export class SerializedLifecycle {
  private tail: Promise<void> = Promise.resolve()
  stopped = false

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.tail.catch(() => {}).then(operation)
    this.tail = queued.then(() => {}, () => {})
    return queued
  }

  stop<T>(operation: () => Promise<T>): Promise<T> {
    this.stopped = true
    return this.enqueue(operation)
  }
}
