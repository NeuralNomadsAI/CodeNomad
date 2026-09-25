type PendingMeasurement = {
  revision: number
  timer?: ReturnType<typeof setTimeout>
  controller?: AbortController
}

type SessionTranscriptMeasurementOptions = {
  delayMs: number
  measure: (instanceId: string, sessionId: string, signal: AbortSignal) => Promise<number>
  account: (instanceId: string, sessionId: string, bytes: number) => void
  onError: (instanceId: string, sessionId: string, error: unknown) => void
}

export class SessionTranscriptMeasurementQueue {
  private pending = new Map<string, PendingMeasurement>()

  constructor(private options: SessionTranscriptMeasurementOptions) {}

  schedule(instanceId: string, sessionId: string): void {
    const entryKey = this.key(instanceId, sessionId)
    const current = this.pending.get(entryKey)
    if (current) {
      if (current.controller) {
        current.controller.abort()
        const replacement = { revision: current.revision + 1 }
        this.pending.set(entryKey, replacement)
        this.arm(instanceId, sessionId, replacement)
        return
      }
      current.revision += 1
      return
    }

    const pending = { revision: 1 }
    this.pending.set(entryKey, pending)
    this.arm(instanceId, sessionId, pending)
  }

  cancel(instanceId: string, sessionId: string): void {
    const entryKey = this.key(instanceId, sessionId)
    const pending = this.pending.get(entryKey)
    if (!pending) return
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.controller?.abort()
    this.pending.delete(entryKey)
  }

  cancelInstance(instanceId: string): void {
    for (const [entryKey, pending] of this.pending) {
      if (!entryKey.startsWith(`${instanceId}\u0000`)) continue
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.controller?.abort()
      this.pending.delete(entryKey)
    }
  }

  private arm(instanceId: string, sessionId: string, pending: PendingMeasurement): void {
    pending.timer = setTimeout(() => {
      pending.timer = undefined
      void this.measure(instanceId, sessionId, pending)
    }, this.options.delayMs)
  }

  private async measure(instanceId: string, sessionId: string, pending: PendingMeasurement): Promise<void> {
    const entryKey = this.key(instanceId, sessionId)
    const measuredRevision = pending.revision
    const controller = new AbortController()
    pending.controller = controller
    try {
      const bytes = await this.options.measure(instanceId, sessionId, controller.signal)
      if (controller.signal.aborted || this.pending.get(entryKey) !== pending) return
      if (pending.revision === measuredRevision) {
        this.pending.delete(entryKey)
        this.options.account(instanceId, sessionId, bytes)
        return
      }
    } catch (error) {
      if (!controller.signal.aborted && this.pending.get(entryKey) === pending && pending.revision === measuredRevision) {
        this.options.account(instanceId, sessionId, Number.POSITIVE_INFINITY)
        try {
          this.options.onError(instanceId, sessionId, error)
        } catch {
          // Accounting is authoritative; error reporting must not undo it.
        }
      }
    } finally {
      if (this.pending.get(entryKey) !== pending) return
      pending.controller = undefined
      if (pending.revision !== measuredRevision) this.arm(instanceId, sessionId, pending)
      else this.pending.delete(entryKey)
    }
  }

  private key(instanceId: string, sessionId: string): string {
    return `${instanceId}\u0000${sessionId}`
  }
}
