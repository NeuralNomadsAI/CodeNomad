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
  /** Switch watermark captured when the failure was received from the relay. */
  watermark?: number
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
  private readonly switches = new Map<string, { at: number; seq: number; credentialID?: string | null }>()
  private readonly steps = new Map<string, { at: number; providerID?: string }>()
  private manualAt = -Infinity
  private manualSeq = 0
  /** Arrival order of observed switches; events from separate relay queues can arrive late. */
  private sequence = 0

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
    this.manualSeq = ++this.sequence
  }

  /** `credentialID` is the newly active credential when known (null: none). */
  switched(integrationID: string, at = this.now(), credentialID?: string | null) {
    if (!Number.isFinite(at)) return
    const previous = this.switches.get(integrationID)
    if (!previous && this.switches.size >= MAX_MARKS) this.switches.delete(this.switches.keys().next().value!)
    this.switches.set(integrationID, { at: Math.max(previous?.at ?? -Infinity, at), seq: ++this.sequence,
      ...(credentialID !== undefined ? { credentialID } : previous && "credentialID" in previous ? { credentialID: previous.credentialID } : {}) })
  }
  /** A failed or ambiguous activation: the active credential is no longer known. */
  activeUnknown(integrationID: string) {
    const previous = this.switches.get(integrationID)
    if (previous) this.switches.set(integrationID, { at: previous.at, seq: previous.seq })
  }
  switchedSince(integrationID: string, at: number) {
    return Math.max(this.switches.get(integrationID)?.at ?? -Infinity, this.manualAt) >= at
  }
  watermark() { return this.sequence }
  /** Any switch of this integration (or manual change) observed after `watermark`. */
  changedAfter(integrationID: string, watermark: number) {
    return Math.max(this.switches.get(integrationID)?.seq ?? 0, this.manualSeq) > watermark
  }
  /** The credential last observed becoming active no later than `at`, when known. */
  activeAt(integrationID: string, at: number): string | null | undefined {
    const latest = this.switches.get(integrationID)
    return latest && latest.at <= at && "credentialID" in latest ? latest.credentialID : undefined
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
