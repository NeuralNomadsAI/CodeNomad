type Job = { run: () => Promise<void>; bytes: number; deadline: number }
type Lane = { jobs: Job[]; timer?: ReturnType<typeof setTimeout> }

/** FIFO per native entity/recipient, without head-of-line blocking other lanes.
 * Exceeding the retained-work budget fails the subscription; reconnect performs
 * authoritative reconciliation rather than silently dropping individual deltas.
 */
export class InstanceEventQueue {
  private readonly lanes = new Map<string, Lane>()
  private count = 0
  private bytes = 0
  private closed = false

  constructor(private readonly fail: (error: Error) => void, private readonly limits = {
    jobs: 2048, bytes: 32 * 1024 * 1024, timeoutMs: 60_000,
  }) {}

  enqueue(key: string, bytes: number, run: () => Promise<void>): void {
    if (this.closed) return
    if (this.count + 1 > this.limits.jobs || this.bytes + bytes > this.limits.bytes) {
      this.reject(new Error("Instance event relay backlog exceeded its budget"))
      return
    }
    this.count++
    this.bytes += bytes
    const existing = this.lanes.get(key)
    const job = { run, bytes, deadline: Date.now() + this.limits.timeoutMs }
    if (existing) existing.jobs.push(job)
    else {
      const lane: Lane = { jobs: [job] }
      this.lanes.set(key, lane)
      void this.drain(key, lane)
    }
  }

  get pending(): number { return this.count }

  close(): void {
    this.closed = true
    for (const lane of this.lanes.values()) {
      clearTimeout(lane.timer)
      lane.jobs.length = 0
    }
    this.lanes.clear()
    this.count = this.bytes = 0
  }

  private reject(error: Error): void {
    if (this.closed) return
    this.close()
    this.fail(error)
  }

  private async drain(key: string, lane: Lane): Promise<void> {
    while (!this.closed && lane.jobs.length) {
      const job = lane.jobs[0]
      const remaining = job.deadline - Date.now()
      if (remaining <= 0) {
        this.reject(new Error("Instance event relay routing timed out"))
        return
      }
      lane.timer = setTimeout(() => this.reject(new Error("Instance event relay routing timed out")), remaining)
      lane.timer.unref?.()
      try {
        await job.run()
      } catch (error) {
        this.reject(error instanceof Error ? error : new Error(String(error)))
      } finally {
        clearTimeout(lane.timer)
      }
      if (this.closed) return
      lane.jobs.shift()
      this.count--
      this.bytes -= job.bytes
    }
    this.lanes.delete(key)
  }
}
