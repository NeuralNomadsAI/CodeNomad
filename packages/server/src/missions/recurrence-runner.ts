import { canonicalAuthority } from "./authority-protocol"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { runMissionExclusive } from "./exclusive"
import { latestDailyDue } from "./recurrence-clock"
import { recurrenceIDSchema, type RecurrenceAdmission, type RecurrenceDocument, type RecurrenceDue } from "./recurrence-contract"
import { isNewDailyDue, NativeMissionRecurrenceStore } from "./recurrence-store"
import { recurrenceInputBudget } from "./recurrence-read-budget"

export interface RecurrenceAuthorizedAdmission {
  /** Fresh owning-authority read, including active protected host incarnation.
   * Throw on unknown/unowned/read-only/disabled authority; returned synchronous
   * fence MUST be passed through native storage/admission preparation. */
  authorize(document: Readonly<RecurrenceDocument>, purpose: "dispatch" | "settle"): Promise<() => true>
  /** Starts ONE ordinary Mission using the exact frozen request. This is NOT
   * ctx.session.prompt: integration must perform fresh full native Mission
   * admission (ownership, profile ENV, inbox, permissions, publication scope).
   * Invoke beforeEffect at actual admission after async preparation, then its
   * synchronous fence immediately before the first external effect. No retries.
   * Rejection requires positive exact no-effect proof; throw means unknown. */
  admit(document: Readonly<RecurrenceDocument>, beforeEffect: () => Promise<() => true>): Promise<RecurrenceAdmission>
}
export type RecurrenceRunOutcome = "inactive" | "not-due" | "pending" | "accepted" | "rejected-before-effect" | "unknown"

/** No timers, activation flags, tool orchestration or headless claims. Protected
 * host composition later owns wakeups/lifetime and supplies authorized admission.
 * Global exclusion covers parallel timers/coordinators/plugin incarnations;
 * the original durable pending key supplies the fail-closed crash protocol. */
export class MissionRecurrenceRunner {
  constructor(private readonly store: NativeMissionRecurrenceStore, private readonly admission: RecurrenceAuthorizedAdmission,
    private readonly now: () => number = Date.now) {}

  tick(id: string): Promise<RecurrenceRunOutcome> { return this.run(id) }
  async trigger(id: string, expectedRevision: number, requestID: string): Promise<RecurrenceRunOutcome> {
    recurrenceIDSchema.parse(requestID)
    return this.run(id, { expectedRevision, requestID })
  }
  private async run(id: string, manual?: { expectedRevision: number; requestID: string }): Promise<RecurrenceRunOutcome> {
    recurrenceIDSchema.parse(id)
    return runMissionExclusive(`recurrence-flight:${this.store.projectToken}:${id}`, async () => {
      const doc = await this.store.read(id)
      if (!doc || doc.state === "stopped" || !manual && doc.state !== "running") return "inactive"
      if (doc.pending) return "pending"
      if (manual && manual.expectedRevision !== doc.revision) throw new Error("Recurrence revision conflict")
      const now = this.now()
      const due: RecurrenceDue = manual ? { kind: "manual", ...manual, at: now }
        : { kind: "daily", clock: doc.config.clock, ...latestDailyDue(doc.config.clock, now) }
      if (due.kind === "daily" && !isNewDailyDue(doc, due)) return "not-due"
      // Pure whole-input capacity rejection: no passage, read or native effect
      // has been reserved, so this is positively no-effect rather than unknown.
      if (!recurrenceInputBudget(doc.config).sufficient) return "rejected-before-effect"
      // Read-only failed authority cannot even reserve a passage.
      const current = await this.admission.authorize(structuredClone(doc), "dispatch")
      assertSynchronousAuthorityGuard(current, "policy-unqualified")
      const reserved = await this.store.reserve(id, doc.revision, due, now, current)
      const beforeEffect = async () => {
        const fresh = await this.store.read(id)
        if (!fresh || fresh.state === "stopped" || !manual && fresh.state !== "running"
          || canonicalAuthority(fresh.pending) !== canonicalAuthority(reserved.pending)
          || canonicalAuthority(fresh.config) !== canonicalAuthority(reserved.config)) throw new Error("Recurrence admission fenced")
        const fence = await this.admission.authorize(structuredClone(fresh), "dispatch")
        const rechecked = await this.store.read(id)
        if (!rechecked || rechecked.revision !== fresh.revision) throw new Error("Recurrence admission changed")
        const current = () => assertSynchronousAuthorityGuard(fence, "policy-unqualified")
        current()
        return current
      }
      try {
        await beforeEffect()
        const ack = await this.admission.admit(structuredClone(reserved), beforeEffect)
        // Metadata/result authority stays fresh even if Pause/Stop intervenes.
        // The external authorizer must distinguish settlement from new sends.
        const fresh = await this.store.read(id)
        if (!fresh) throw new Error("Recurrence missing")
        const settlementFence = await this.admission.authorize(structuredClone(fresh), "settle")
        await this.store.recordAdmission(id, ack, this.now(), settlementFence)
        return ack.kind
      } catch {
        // Includes throw after effect, malformed/wrong ACK, admission denial
        // after reservation and ambiguous metadata publication. Never replay.
        return "unknown"
      }
    })
  }
}
