/** Host-wide admission: at most `running` tasks at once, `queued` more waiting, the rest refused. */
export class RequestBudget {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly running: number, private readonly queued: number) {}

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw signal.reason
    if (this.active < this.running && !this.waiting.length) this.active += 1
    else {
      if (this.waiting.length >= this.queued) throw new ForgeBusyError("Forge requests busy")
      // A finishing task hands its slot over to the first waiter.
      await new Promise<void>((resolve, reject) => {
        const start = () => { signal.removeEventListener("abort", cancel); resolve() }
        const cancel = () => { this.waiting.splice(this.waiting.indexOf(start), 1); reject(signal.reason) }
        this.waiting.push(start)
        signal.addEventListener("abort", cancel, { once: true })
      })
    }
    try {
      if (signal.aborted) throw signal.reason
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active -= 1
    }
  }
}

export class ForgeBusyError extends Error {}

type Load<T> = { at: number; value: Promise<T>; settled: boolean; controller: AbortController; consumers: number }

/**
 * Loads shared by key: identical callers join one load, a completed one is
 * served for `ttl` unless a caller asks for a fresh one, and a load still
 * running is cancelled once every caller has gone. A cancelled load is never
 * joined, failures are never served, and eviction never drops a running load,
 * so its identity keeps being shared.
 */
export class SharedLoads<T> {
  private readonly loads = new Map<string, Load<T>>()

  constructor(private readonly ttl: number, private readonly limit: number, private readonly now: () => number) {}

  get(key: string, fresh: boolean, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    let entry = this.loads.get(key)
    if (!entry || entry.controller.signal.aborted || (entry.settled && (fresh || this.now() - entry.at >= this.ttl))) {
      const controller = new AbortController()
      const created: Load<T> = { at: this.now(), settled: false, controller, consumers: 0, value: load(controller.signal) }
      entry = created
      this.loads.delete(key)
      this.loads.set(key, created)
      void created.value.then(() => { created.settled = true; this.evict() }, () => {
        created.settled = true
        if (this.loads.get(key) === created) this.loads.delete(key)
      })
    }
    return this.consume(entry, signal)
  }

  private consume(entry: Load<T>, signal: AbortSignal | undefined): Promise<T> {
    entry.consumers += 1
    return new Promise((resolve, reject) => {
      const leave = () => {
        signal?.removeEventListener("abort", abandon)
        entry.consumers -= 1
      }
      const abandon = () => {
        leave()
        // The last caller leaving cancels the shared load, its CLI process or fetch included.
        if (entry.consumers === 0 && !entry.settled) entry.controller.abort(signal!.reason)
        reject(signal!.reason)
      }
      signal?.addEventListener("abort", abandon, { once: true })
      entry.value.then(value => { leave(); resolve(value) }, error => { leave(); reject(error) })
    })
  }

  /** Drops the oldest completed loads beyond the limit; running loads stay shared. */
  private evict(): void {
    for (const [key, entry] of this.loads) {
      if (this.loads.size <= this.limit) return
      if (entry.settled) this.loads.delete(key)
    }
  }
}
