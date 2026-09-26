// Reserve browser connections for foreground work across all workspace scans.
export class BackgroundReadQueue {
  private active = 0
  private readonly waiting: Array<() => void> = []
  private readonly visibleWaiting: Array<() => void> = []

  constructor(private readonly concurrency = 2) {}

  async run<T>(signal: AbortSignal, read: () => Promise<T>, priority: "normal" | "visible" = "normal"): Promise<T> {
    signal.throwIfAborted()
    const waiting = priority === "visible" ? this.visibleWaiting : this.waiting
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = waiting.indexOf(start)
        if (index >= 0) waiting.splice(index, 1)
        reject(signal.reason)
      }
      const start = () => {
        signal.removeEventListener("abort", abort)
        this.active += 1
        resolve()
      }
      if (this.active < this.concurrency) start()
      else {
        waiting.push(start)
        signal.addEventListener("abort", abort, { once: true })
      }
    })
    try {
      signal.throwIfAborted()
      return await read()
    } finally {
      this.active -= 1
      // Visible secondary panels go before bulk scans, within the same budget.
      // They still leave foreground transcript connections available.
      const next = this.visibleWaiting.shift() ?? this.waiting.shift()
      next?.()
    }
  }
}

export const backgroundReads = new BackgroundReadQueue(2)

// A clicked file is foreground work: one reserved lane prevents long directory
// and status scans from delaying the reader, while retaining connection headroom.
export const previewReads = new BackgroundReadQueue(1)
