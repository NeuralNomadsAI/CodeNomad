// Reserve browser connections for foreground work across all workspace scans.
export class BackgroundReadQueue {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly concurrency = 2) {}

  async run<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(start)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal.reason)
      }
      const start = () => {
        signal.removeEventListener("abort", abort)
        this.active += 1
        resolve()
      }
      if (this.active < this.concurrency) start()
      else {
        this.waiting.push(start)
        signal.addEventListener("abort", abort, { once: true })
      }
    })
    try {
      signal.throwIfAborted()
      return await read()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}

export const backgroundReads = new BackgroundReadQueue(2)
