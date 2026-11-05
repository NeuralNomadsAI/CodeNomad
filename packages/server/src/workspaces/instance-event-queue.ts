export type InstanceEventReservation = { deliveries: Map<string, number> }
type Job = { run: (reservation: InstanceEventReservation) => Promise<void>; bytes: number; deadline: number; reservation: InstanceEventReservation }
type Lane = { jobs: Job[]; timer?: ReturnType<typeof setTimeout> }

export class InstanceEventQueueError extends Error {
  constructor(readonly gap: "overflow" | "deadline") {
    super(gap === "overflow" ? "Instance event relay backlog exceeded its budget" : "Instance event relay routing timed out")
  }
}

/** Fixed shares; existing local work drains naturally when explicit shares activate. */
export class InstanceEventBudget {
  explicitSources = 0
  jobs = 0
  bytes = 0

  admit(jobs: number, bytes: number): boolean {
    if (this.jobs + jobs > 2048 || this.bytes + bytes > 32 * 1024 * 1024) return false
    this.jobs += jobs
    this.bytes += bytes
    return true
  }

  release(jobs: number, bytes: number): void {
    this.jobs -= jobs
    this.bytes -= bytes
  }
}

/** FIFO per native entity/recipient, without head-of-line blocking other lanes.
 * Exceeding the retained-work budget fails the subscription; reconnect performs
 * authoritative reconciliation rather than silently dropping individual deltas.
 */
export class InstanceEventQueue {
  private readonly lanes = new Map<string, Lane>()
  private count = 0
  private bytes = 0
  private closed = false
  private sharing: boolean
  private transitionGap = false

  constructor(private readonly fail: (error: Error) => void, private readonly limits = {
    jobs: 2048, bytes: 32 * 1024 * 1024, timeoutMs: 60_000,
  }, private readonly budget?: InstanceEventBudget, private readonly explicit = false,
    private readonly drainingGap?: () => void) { this.sharing = Boolean(budget?.explicitSources) }

  enqueue(key: string, bytes: number, run: (reservation: InstanceEventReservation) => Promise<void>, receivedAt = Date.now(), deliveries = new Map<string, number>()): void {
    if (this.closed) return
    const jobs = this.budget ? this.explicit ? 448 : this.budget.explicitSources ? 256 : 2048 : this.limits.jobs
    const byteLimit = this.budget ? (this.explicit ? 7 : this.budget.explicitSources ? 4 : 32) * 1024 * 1024 : this.limits.bytes
    const sharing = Boolean(this.budget?.explicitSources)
    if (!this.explicit && !this.sharing && sharing && (this.count > jobs || this.bytes > byteLimit)) {
      // Keep grandfathered work, including prepaid deliveries. An observed gap
      // stops new admission until it drains, then reconnects authoritatively.
      this.transitionGap = true
      this.drainingGap?.()
    }
    this.sharing = sharing
    if (this.transitionGap) return
    const retainedJobs = 1 + deliveries.size
    const retainedBytes = bytes + [...deliveries.values()].reduce((sum, value) => sum + value, 0)
    if (this.count + retainedJobs > jobs || this.bytes + retainedBytes > byteLimit || (this.budget && !this.budget.admit(retainedJobs, retainedBytes))) {
      this.reject(new InstanceEventQueueError("overflow"))
      return
    }
    this.count += retainedJobs
    this.bytes += retainedBytes
    this.schedule(key, { run, bytes, deadline: receivedAt + this.limits.timeoutMs, reservation: { deliveries } })
  }

  /** Delivery capacity was charged at ingestion, before any ownership wait. */
  enqueueDelivery(key: string, reservation: InstanceEventReservation, recipient: string, run: () => Promise<void>, receivedAt: number): void {
    if (this.closed) return
    const bytes = reservation.deliveries.get(recipient)
    if (bytes === undefined) return
    reservation.deliveries.delete(recipient)
    this.schedule(key, { run, bytes, deadline: receivedAt + this.limits.timeoutMs, reservation: { deliveries: new Map() } })
  }

  private schedule(key: string, job: Job): void {
    const existing = this.lanes.get(key)
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
      for (const job of lane.jobs) job.reservation.deliveries.clear()
      lane.jobs.length = 0
    }
    this.lanes.clear()
    this.budget?.release(this.count, this.bytes)
    this.count = this.bytes = 0
  }

  private reject(error: Error): void {
    if (this.closed) return
    this.close()
    this.fail(error)
  }

  private async drain(key: string, lane: Lane): Promise<void> {
    let batch = 0
    while (!this.closed && lane.jobs.length) {
      if (++batch % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve))
      if (this.closed) return
      const job = lane.jobs[0]
      const remaining = job.deadline - Date.now()
      if (remaining <= 0) {
        this.reject(new InstanceEventQueueError("deadline"))
        return
      }
      lane.timer = setTimeout(() => this.reject(new InstanceEventQueueError("deadline")), remaining)
      lane.timer.unref?.()
      try {
        await job.run(job.reservation)
      } catch (error) {
        this.reject(error instanceof Error ? error : new Error(String(error)))
      } finally {
        clearTimeout(lane.timer)
      }
      if (this.closed) return
      lane.jobs.shift()
      const jobs = 1 + job.reservation.deliveries.size
      const bytes = job.bytes + [...job.reservation.deliveries.values()].reduce((sum, value) => sum + value, 0)
      job.reservation.deliveries.clear()
      this.count -= jobs
      this.bytes -= bytes
      this.budget?.release(jobs, bytes)
      if (this.count === 0 && this.transitionGap) {
        this.reject(new InstanceEventQueueError("overflow"))
        return
      }
    }
    this.lanes.delete(key)
  }
}
