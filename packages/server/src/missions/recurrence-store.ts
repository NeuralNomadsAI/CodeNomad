import { canonicalAuthority } from "./authority-protocol"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { runMissionExclusive } from "./exclusive"
import { stableToken, type MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { latestDailyDue } from "./recurrence-clock"
import {
  parseRecurrenceDocument, recurrenceAdmissionSchema, recurrenceConfigSchema, recurrenceIDSchema,
  recurrenceMessageID, recurrencePassageID, recurrenceResultSchema,
  RECURRENCE_HISTORY_LIMIT, RECURRENCE_MAX_BYTES, RECURRENCE_SCHEDULE_LIMIT, RECURRENCE_STORAGE_PREFIX,
  type RecurrenceAdmission, type RecurrenceConfig, type RecurrenceDocument, type RecurrenceDue, type RecurrenceResult,
} from "./recurrence-contract"

export type RecurrenceStorage = MissionStorage & {
  /** Native SQLite adapters enforce this inside BEGIN IMMEDIATE; null means create. */
  compareAndSet?(key: string, value: MissionJsonValue, expectedRevision: number | null, current: () => true): Promise<void>
}

/** Native JSON only. All mutators require the owning authorized host/route;
 * this module supplies durability, not grants. Plain native get/set is NOT CAS;
 * production must use a conditional adapter. In-process exclusion only coalesces
 * plugin incarnations sharing this JS process. */
export class NativeMissionRecurrenceStore {
  readonly projectToken: string
  private readonly prefix: string
  constructor(private readonly storage: RecurrenceStorage, readonly projectID: string, readonly projectCanonical: string) {
    if (!projectID.trim() || projectID.length > 240 || !projectCanonical || projectCanonical.length > 4096) throw new Error("Invalid recurrence project")
    this.projectToken = stableToken(`${projectID}\0${projectCanonical}`, 24)
    this.prefix = `${RECURRENCE_STORAGE_PREFIX}/project/${this.projectToken}/`
  }

  async read(id: string): Promise<RecurrenceDocument | undefined> {
    const input = await this.storage.get(this.key(id))
    return input === undefined ? undefined : parseRecurrenceDocument(input, this.projectID, this.projectCanonical, id)
  }

  /** Bounded prefix pages. Foreign/misplaced/unsorted bytes or cursors fail
   * closed without repair. No scan ever enters one-shot or legacy namespaces. */
  async list(): Promise<RecurrenceDocument[]> {
    const result: RecurrenceDocument[] = []
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix: this.prefix, after, limit: 16 })
      if (!Array.isArray(page.entries) || page.entries.length > 16 || result.length + page.entries.length > RECURRENCE_SCHEDULE_LIMIT) {
        throw new Error("Recurrence storage capacity")
      }
      let previous = after ?? this.prefix
      for (const entry of page.entries) {
        const id = entry.key.slice(this.prefix.length)
        if (!entry.key.startsWith(this.prefix) || entry.key <= previous || this.key(id) !== entry.key) throw new Error("Invalid recurrence page")
        result.push(parseRecurrenceDocument(entry.value, this.projectID, this.projectCanonical, id))
        previous = entry.key
      }
      if (page.next !== undefined && (!page.entries.length || page.next !== previous || result.length >= RECURRENCE_SCHEDULE_LIMIT)) {
        throw new Error("Invalid recurrence cursor")
      }
      after = page.next
    } while (after !== undefined)
    return result
  }

  create(id: string, input: RecurrenceConfig, now: number, current: () => true): Promise<RecurrenceDocument> {
    return this.exclusive(async () => {
      this.key(id)
      const config = recurrenceConfigSchema.parse(JSON.parse(canonicalAuthority(input)))
      if (await this.read(id)) throw new Error("Recurrence already exists")
      if ((await this.list()).length >= RECURRENCE_SCHEDULE_LIMIT) throw new Error("Recurrence storage capacity")
      const doc: RecurrenceDocument = { version: 1, projectID: this.projectID, projectCanonical: this.projectCanonical,
        id, revision: 0, scheduleRevision: 0, createdAt: now, state: "paused", config,
        lastDaily: null, settledCount: 0, cursors: [], pending: null, history: [] }
      return this.publish(doc, current, null)
    })
  }

  configure(id: string, expectedRevision: number, input: RecurrenceConfig, current: () => true): Promise<RecurrenceDocument> {
    return this.change(id, expectedRevision, current, doc => {
      if (doc.pending || doc.state === "stopped") throw new Error("Recurrence pending or stopped")
      const config = recurrenceConfigSchema.parse(JSON.parse(canonicalAuthority(input)))
      for (const field of ["profiles", "taskMode", "profileID", "executionHost"] as const) {
        if (canonicalAuthority(doc.config[field]) !== canonicalAuthority(config[field])) throw new Error("Recurrence profile is immutable")
      }
      doc.config = config
      doc.scheduleRevision++
      // Deliberately retain createdAt, original daily high-water and cursors.
    })
  }

  /** Explicit opt-in/resume, Pause and terminal Stop. Pending results may still
   * settle in either inactive state. Never changes a native session's controls. */
  setState(id: string, expectedRevision: number, state: RecurrenceDocument["state"], current: () => true): Promise<RecurrenceDocument> {
    return this.change(id, expectedRevision, current, doc => {
      if (doc.state === "stopped") throw new Error("Recurrence is terminal")
      doc.state = state
    })
  }

  reserve(id: string, expectedRevision: number, due: RecurrenceDue, now: number, current: () => true): Promise<RecurrenceDocument> {
    return this.change(id, expectedRevision, current, doc => {
      if (doc.pending || doc.state === "stopped" || due.kind === "daily" && doc.state !== "running") throw new Error("Recurrence cannot trigger")
      if (due.kind === "daily") {
        const latest = latestDailyDue(doc.config.clock, now)
        if (latest.at !== due.at || latest.civilDay !== due.civilDay || !isNewDailyDue(doc, due)
          || canonicalAuthority(due.clock) !== canonicalAuthority(doc.config.clock)) throw new Error("Recurrence due conflict")
        doc.lastDaily = due
      } else if (due.expectedRevision !== expectedRevision || due.at !== now) throw new Error("Recurrence manual conflict")
      const passageID = recurrencePassageID(this.projectToken, id, doc.scheduleRevision, due)
      // Unacknowledged from the FIRST durable publication. A crash at any point
      // after this write parks the original key; it never authorizes replay.
      doc.pending = { passage: { id: passageID, messageID: recurrenceMessageID(passageID),
        scheduleRevision: doc.scheduleRevision, due, createdAt: now }, admission: null }
    })
  }

  recordAdmission(id: string, input: RecurrenceAdmission, now: number, current: () => true): Promise<RecurrenceDocument> {
    return this.exclusive(async () => {
      const doc = await this.required(id), admission = recurrenceAdmissionSchema.parse(JSON.parse(canonicalAuthority(input)))
      const pending = this.exactPending(doc, admission)
      if (pending.admission) {
        if (canonicalAuthority(pending.admission) !== canonicalAuthority(admission)) throw new Error("Recurrence admission conflict")
        return doc
      }
      if (admission.kind === "accepted") pending.admission = admission
      else this.settle(doc, admission, now)
      doc.revision++
      return this.publish(doc, current, doc.revision - 1)
    })
  }

  /** Caller supplies fresh authorized native terminal evidence, not model prose.
   * Unknown admissions first need exact recordAdmission reconciliation. */
  finish(id: string, input: RecurrenceResult, now: number, current: () => true): Promise<RecurrenceDocument> {
    return this.exclusive(async () => {
      const doc = await this.required(id), result = recurrenceResultSchema.parse(JSON.parse(canonicalAuthority(input)))
      const pending = this.exactPending(doc, result), admission = pending.admission
      if (!admission || result.missionID !== admission.missionID || result.conversationID !== admission.conversationID
        || result.cursors.some(cursor => !doc.config.watchedConversationIDs.includes(cursor.conversationID))) throw new Error("Recurrence result conflict")
      this.settle(doc, result, now)
      doc.cursors = [...new Map([...doc.cursors, ...result.cursors].map(cursor => [cursor.conversationID, cursor])).values()]
      doc.revision++
      return this.publish(doc, current, doc.revision - 1)
    })
  }

  private settle(doc: RecurrenceDocument, result: RecurrenceAdmission & { kind: "rejected-before-effect" } | RecurrenceResult, now: number) {
    const reference = "cursors" in result ? (({ cursors: _cursors, ...receipt }) => receipt)(result) : result
    doc.history.push({ passage: doc.pending!.passage, result: reference, settledAt: now })
    doc.history = doc.history.slice(-RECURRENCE_HISTORY_LIMIT)
    doc.settledCount++
    doc.pending = null
  }
  private exactPending(doc: RecurrenceDocument, identity: { passageID: string; messageID: string }) {
    if (!doc.pending || doc.pending.passage.id !== identity.passageID || doc.pending.passage.messageID !== identity.messageID) throw new Error("Recurrence passage conflict")
    return doc.pending
  }
  private change(id: string, expected: number, current: () => true, update: (doc: RecurrenceDocument) => void) {
    return this.exclusive(async () => {
      const doc = await this.required(id)
      if (!Number.isSafeInteger(expected) || doc.revision !== expected) throw new Error("Recurrence revision conflict")
      update(doc)
      doc.revision++
      return this.publish(doc, current, expected)
    })
  }
  private async required(id: string) {
    const doc = await this.read(id)
    if (!doc) throw new Error("Recurrence missing")
    return doc
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return runMissionExclusive(`recurrence-mutation:${this.projectToken}`, operation)
  }
  private key(id: string) { return `${this.prefix}${recurrenceIDSchema.parse(id)}` }
  private async publish(doc: RecurrenceDocument, current: () => true, expectedRevision: number | null): Promise<RecurrenceDocument> {
    const parsed = parseRecurrenceDocument(doc, this.projectID, this.projectCanonical, doc.id)
    const bytes = canonicalAuthority(parsed, RECURRENCE_MAX_BYTES)
    const fence = () => assertSynchronousAuthorityGuard(current, "policy-unqualified")
    fence()
    const value = JSON.parse(bytes) as MissionJsonValue
    if (this.storage.compareAndSet) await this.storage.compareAndSet(this.key(doc.id), value, expectedRevision, fence)
    else await this.storage.set(this.key(doc.id), value, fence)
    // A failed/partial/foreign publication never reaches external admission.
    const saved = await this.required(doc.id)
    if (canonicalAuthority(saved, RECURRENCE_MAX_BYTES) !== bytes) throw new Error("Recurrence publication unknown")
    fence()
    return saved
  }
}

export function isNewDailyDue(doc: RecurrenceDocument, due: { civilDay: string; at: number }): boolean {
  return due.at >= doc.createdAt && (!doc.lastDaily || due.at > doc.lastDaily.at && due.civilDay > doc.lastDaily.civilDay)
}
