const MAX_MARKS = 256
const MAX_STEPS = 512
const HOUR_MS = 3_600_000
/** Attribution window when the failing step's start was not observed (e.g. after reconnect). */
const UNOBSERVED_STEP_MS = 60_000

export interface QuotaFailure {
  sessionID: string
  /** Native event time (daemon clock). */
  failedAt: number
  /** Go's `metadata.limitName`: "5 hour", "weekly" or "monthly". */
  limitName?: string
}

// OpenCode keeps no reset time for provider.quota failures. A rolling 5-hour
// limit expires after 5 h; weekly, monthly and unknown limits are rechecked
// after 24 h rather than parked for their whole window.
export function quotaMarkTtl(limitName?: string) {
  return limitName !== undefined && /^\s*5\s*h(?:ours?)?\s*$/i.test(limitName) ? 5 * HOUR_MS : 24 * HOUR_MS
}

/**
 * Per-connection, in-memory reactive exhaustion marks plus the bounded
 * bookkeeping needed to attribute a failure to the account that served it.
 */
export class QuotaMarks {
  private readonly marks = new Map<string, number>()
  private readonly switches = new Map<string, number>()
  private readonly steps = new Map<string, { at: number; providerID?: string }>()
  private manualAt = -Infinity

  constructor(private readonly now = () => Date.now()) {}

  mark(integrationID: string, credentialID: string, limitName?: string) {
    const key = JSON.stringify([integrationID, credentialID])
    this.marks.delete(key)
    if (this.marks.size >= MAX_MARKS) this.marks.delete(this.marks.keys().next().value!)
    this.marks.set(key, this.now() + quotaMarkTtl(limitName))
  }
  has(integrationID: string, credentialID: string) {
    const key = JSON.stringify([integrationID, credentialID])
    const expiresAt = this.marks.get(key)
    if (expiresAt === undefined) return false
    if (expiresAt > this.now()) return true
    this.marks.delete(key)
    return false
  }
  clear(integrationID: string, credentialID: string) {
    this.marks.delete(JSON.stringify([integrationID, credentialID]))
  }
  manualChange() {
    this.marks.clear()
    this.manualAt = this.now()
  }

  switched(integrationID: string, at = this.now()) {
    if (!Number.isFinite(at)) return
    if (!this.switches.has(integrationID) && this.switches.size >= MAX_MARKS) this.switches.delete(this.switches.keys().next().value!)
    this.switches.set(integrationID, Math.max(this.switches.get(integrationID) ?? -Infinity, at))
  }
  switchedSince(integrationID: string, at: number) {
    return Math.max(this.switches.get(integrationID) ?? -Infinity, this.manualAt) >= at
  }

  stepStarted(sessionID: string, at: number, providerID?: string) {
    if (!Number.isFinite(at)) return
    this.steps.delete(sessionID)
    if (this.steps.size >= MAX_STEPS) this.steps.delete(this.steps.keys().next().value!)
    this.steps.set(sessionID, { at, ...(providerID ? { providerID } : {}) })
  }
  stepFor(sessionID: string, failedAt: number): { startedAt: number; providerID?: string } {
    const step = this.steps.get(sessionID)
    return step && step.at <= failedAt ? { startedAt: step.at, providerID: step.providerID } : { startedAt: failedAt - UNOBSERVED_STEP_MS }
  }
}
