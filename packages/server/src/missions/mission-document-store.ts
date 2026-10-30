import { canonicalAuthority } from "./authority-protocol"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { runMissionExclusive, runAvailableMissionExclusive } from "./exclusive"
import type { MissionStorage } from "./journal"
import { documentID, missionConfigurationSchema, MISSION_DOCUMENT_MAX_BYTES, type MissionConfiguration } from "./launch-policy"
import { MISSION_DOCUMENT_PREFIX, MISSION_TOMBSTONE_MAX_BYTES, missionTombstoneRegistrySchema, missionTombstoneSchema,
  parseMissionDocument, parseMissionTombstoneRegistry, type MissionDocument, type MissionDocumentTombstone } from "./mission-document"
import { stableToken } from "./receipt-identity"
import type { MissionJsonValue } from "./model"

/** A conditional native adapter is mandatory. It checks expectedRevision and
 * current inside the same transaction as publication; plain get/set cannot do it. */
export type MissionDocumentStorage = Pick<MissionStorage, "get"> & {
  compareAndSet(key: string, value: MissionJsonValue, expectedRevision: number | null, current: () => true): Promise<void>
}
export type MissionDocumentMutation = NativeMissionDocumentStore

/** Point reads/writes use their own namespace. Passage journals retain their
 * existing ranges, per-mission capacity, deletion reserve and activation index. */
export class NativeMissionDocumentStore {
  readonly projectToken: string
  private readonly prefix: string
  private borrowed?: () => true
  constructor(private readonly storage: MissionDocumentStorage, readonly projectID: string, readonly projectCanonical: string) {
    if (!projectID || !projectCanonical) throw new Error("Invalid Mission document project")
    this.projectToken = stableToken(`${projectID}\0${projectCanonical}`, 24)
    this.prefix = `${MISSION_DOCUMENT_PREFIX}/project/${this.projectToken}`
  }

  async read(id: string): Promise<MissionDocument | MissionDocumentTombstone | undefined> {
    this.borrowed?.()
    const input = await this.storage.get(this.key(id))
    this.borrowed?.()
    if (input === undefined) return undefined
    if (input && typeof input === "object" && "deletedAt" in input) {
      const result = missionTombstoneSchema.parse(input)
      if (result.id !== id || result.projectID !== this.projectID || result.projectCanonical !== this.projectCanonical)
        throw new Error("Invalid Mission tombstone identity")
      return result
    }
    return parseMissionDocument(input, { id, projectID: this.projectID, projectCanonical: this.projectCanonical })
  }

  create(id: string, configuration: MissionConfiguration, now: number, current: () => true, oneTime: MissionDocument["oneTime"] = null,
    creation?: MissionDocument["creation"]): Promise<MissionDocument> {
    return this.exclusive(async () => {
      if (await this.read(id) || (await this.registry()).entries.some(item => item.id === id)) throw new Error("Mission document already exists or deleted")
      const doc: MissionDocument = { version: 1, id, projectID: this.projectID, projectCanonical: this.projectCanonical,
        revision: 0, configurationGeneration: 1, timeGeneration: 1, createdAt: now,
        configuration: missionConfigurationSchema.parse(configuration), state: "paused", firstPlayedAt: null,
        oneShotAt: null, slotEndsAt: null, launchedCount: 0, settledCount: 0, successfulCount: 0, checks: { count: 0, since: now }, lastSuccessfulPassageID: null, everCreatedTask: false, blocked: null,
        calendars: [], synchronization: null, deletion: null, checkpoints: [], pending: null, history: [], oneTime, scheduleActivation: null, calendarOwner: null, fanIn: null,
        ...(creation === undefined ? {} : { creation }) }
      return this.publish(doc, null, current)
    })
  }

  change(id: string, expectedRevision: number, current: () => true, update: (document: MissionDocument) => void,
    prepare?: () => Promise<void>): Promise<MissionDocument> {
    return this.exclusive(() => this.changeUnlocked(id, expectedRevision, current, update, prepare))
  }

  /** Hold only the project mutation exclusion across native I/O. Each change
   * keeps its own short SQL CAS. Always use the supplied view inside this scope. */
  withExclusion<T>(operation: (locked: NativeMissionDocumentStore) => Promise<T>, options?: { wait: false }): Promise<T> {
    return this.exclusive(async () => {
      let active = true
      const locked = new NativeMissionDocumentStore(this.storage, this.projectID, this.projectCanonical)
      locked.borrowed = (): true => { this.borrowed?.(); if (!active) throw new Error("Mission document exclusion ended"); return true }
      try { return await operation(locked) } finally { active = false }
    }, options?.wait === false)
  }
  assertActive(): true {
    if (!this.borrowed) throw new Error("Mission document exclusion is not owned")
    return this.borrowed()
  }

  private async changeUnlocked(id: string, expectedRevision: number, current: () => true, update: (document: MissionDocument) => void,
    prepare?: () => Promise<void>): Promise<MissionDocument> {
      assertSynchronousAuthorityGuard(current, "policy-unqualified")
      const doc = await this.required(id)
      if (!Number.isSafeInteger(expectedRevision) || doc.revision !== expectedRevision) throw new Error("Mission document revision conflict")
      const previous = structuredClone(doc)
      const result = update(doc) as unknown
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result)
        throw new Error("Mission document update must be synchronous")
      if (canonicalAuthority(doc, MISSION_DOCUMENT_MAX_BYTES) === canonicalAuthority(previous, MISSION_DOCUMENT_MAX_BYTES)) {
        await prepare?.()
        assertSynchronousAuthorityGuard(current, "policy-unqualified")
        return previous
      }
      if (previous.preparation?.pending) {
        const { attempted, pending: _pending, ...intent } = previous.preparation
        const { attempted: nextAttempted, pending: _nextPending, ...nextIntent } = doc.preparation ?? {}
        if (attempted && !nextAttempted || canonicalAuthority(intent) !== canonicalAuthority(nextIntent))
          throw new Error("Original Mission preparation is immutable")
      }
      if (previous.calendarOwner?.operation.textEdit) {
        const original = previous.calendarOwner.operation, next = doc.calendarOwner?.operation
        if (!next || original.requestID !== next.requestID || original.expectedRevision !== next.expectedRevision
          || original.fingerprint !== next.fingerprint || original.action !== next.action || original.startedAt !== next.startedAt
          || next.textEdit && canonicalAuthority(original.textEdit) !== canonicalAuthority(next.textEdit))
          throw new Error("Original Mission passage text intent is immutable")
      }
      if (previous.oneTime && doc.oneTime?.coordinatorSessionID !== previous.oneTime.coordinatorSessionID
        && !(previous.preparation?.pending && doc.preparation?.pending === false
          && doc.oneTime?.coordinatorSessionID === previous.preparation.coordinatorSessionID))
        throw new Error("Mission coordinator rebinding requires its original preparation")
      if (canonicalAuthority(previous.dormantJournal ?? null) !== canonicalAuthority(doc.dormantJournal ?? null)
        && !(previous.preparation?.pending && doc.preparation?.pending === false && previous.firstPlayedAt === null
          || previous.dormantJournal && doc.dormantJournal?.revision === previous.dormantJournal.revision
            && !previous.dormantJournal.deleted && doc.dormantJournal.deleted && doc.deletion))
        throw new Error("Mission journal ownership requires its original preparation or deletion")
      if (doc.id !== previous.id || doc.projectID !== previous.projectID || doc.projectCanonical !== previous.projectCanonical
        || canonicalAuthority(doc.creation ?? null) !== canonicalAuthority(previous.creation ?? null)
        || doc.createdAt !== previous.createdAt || previous.firstPlayedAt !== null && doc.firstPlayedAt !== previous.firstPlayedAt
        || doc.launchedCount < previous.launchedCount || doc.settledCount < previous.settledCount || doc.successfulCount < previous.successfulCount
         || doc.successfulCount === previous.successfulCount && doc.lastSuccessfulPassageID !== previous.lastSuccessfulPassageID
         || previous.checks && (!doc.checks || doc.checks.since !== previous.checks.since || doc.checks.count < previous.checks.count)
         || previous.pending?.admissionAttempted && doc.pending?.id === previous.pending.id && doc.pending.admissionAttempted !== true
         || previous.pending && doc.pending?.id === previous.pending.id && doc.pending.manualExpectedRevision !== previous.pending.manualExpectedRevision
        || doc.configurationGeneration < previous.configurationGeneration || doc.timeGeneration < previous.timeGeneration
        || previous.everCreatedTask && !doc.everCreatedTask || previous.deletion && canonicalAuthority(doc.deletion) !== canonicalAuthority(previous.deletion)
         || previous.oneTime && (!doc.oneTime || doc.oneTime.creationRequestID !== previous.oneTime.creationRequestID
           || doc.oneTime.creationDigest !== previous.oneTime.creationDigest || canonicalAuthority(doc.oneTime.location) !== canonicalAuthority(previous.oneTime.location))
         || previous.oneTime?.firstPlay?.acknowledgement && canonicalAuthority(previous.oneTime.firstPlay.acknowledgement, MISSION_DOCUMENT_MAX_BYTES)
          !== canonicalAuthority(doc.oneTime?.firstPlay?.acknowledgement ?? null, MISSION_DOCUMENT_MAX_BYTES)
         || previous.oneTime?.firstPlay && previous.oneTime.firstPlay.inputText !== doc.oneTime?.firstPlay?.inputText
        || previous.state === "stopped" && doc.state !== "stopped"
        || previous.everCreatedTask && previous.configuration.template !== doc.configuration.template
        || previous.calendars.some(old => doc.calendars.some(item => item.scheduleID === old.scheduleID
          && (item.timeGeneration !== old.timeGeneration || item.sessionID !== old.sessionID || item.highWater < old.highWater))))
        throw new Error("Mission document progress is monotone")
      doc.revision = expectedRevision + 1
       return this.publish(doc, expectedRevision, current, prepare)
  }

  /** Native cleanup must first reconcile every mapping/preparation/control. A
   * full registry keeps the complete stopped document visible; barriers never evict. */
  reserveDeletion(id: string, expectedRevision: number, current: () => true): Promise<void> {
    return this.exclusive(() => this.reserveDeletionUnlocked(id, expectedRevision, current))
  }
  private async reserveDeletionUnlocked(id: string, expectedRevision: number, current: () => true): Promise<void> {
      assertSynchronousAuthorityGuard(current, "policy-unqualified")
      const doc = await this.required(id)
      if (doc.revision !== expectedRevision || !doc.deletion || doc.state !== "stopped") throw new Error("Mission deletion reconciliation pending")
      await this.reserveDeletionSlot(doc, current)
  }

  compact(id: string, expectedRevision: number, now: number, current: () => true): Promise<MissionDocumentTombstone> {
    return this.exclusive(() => this.compactUnlocked(id, expectedRevision, now, current))
  }
  private async compactUnlocked(id: string, expectedRevision: number, now: number, current: () => true): Promise<MissionDocumentTombstone> {
      assertSynchronousAuthorityGuard(current, "policy-unqualified")
      const existing = await this.read(id)
      if (existing && "deletedAt" in existing && existing.revision === expectedRevision + 1) return existing
      const doc = await this.required(id)
      if (doc.revision !== expectedRevision || !doc.deletion || doc.state !== "stopped"
        || doc.pending || doc.synchronization || doc.calendars.length || doc.blocked === "unknown" || doc.preparation?.pending || doc.calendarOwner?.operation.textEdit
        || doc.dormantJournal && !doc.dormantJournal.deleted
        || doc.oneTime?.firstPlay && doc.oneTime.firstPlay.admittedAt === null
        || doc.scheduleActivation?.targets.some(target => target.attempted && !target.acknowledged)) throw new Error("Mission deletion reconciliation pending")
      const reservation = await this.reserveDeletionSlot(doc, current)
      const tombstone = missionTombstoneSchema.parse({ version: 1, id, projectID: this.projectID, projectCanonical: this.projectCanonical,
        revision: expectedRevision + 1, requestID: doc.deletion.requestID, expectedRevision: doc.deletion.expectedRevision,
        deleteManagedSessions: doc.deletion.deleteManagedSessions, deletedAt: reservation.deletedAt, timeGeneration: doc.timeGeneration })
      await this.commit(this.key(id), tombstone, expectedRevision, current)
      return tombstone
  }

  private async reserveDeletionSlot(doc: MissionDocument, current: () => true) {
    const stored = await this.storage.get(`${this.prefix}/tombstones`)
    const registry = parseMissionTombstoneRegistry(stored ?? { version: 1, revision: 0, entries: [] })
    const prior = registry.entries.find(item => item.id === doc.id)
    if (prior) {
      if (prior.requestID !== doc.deletion!.requestID) throw new Error("Mission tombstone conflict")
      return prior
    }
    const reservation = { id: doc.id, requestID: doc.deletion!.requestID, deletedAt: doc.deletion!.requestedAt }
    registry.entries.push(reservation)
    const expected = registry.revision++
    await this.commit(`${this.prefix}/tombstones`, missionTombstoneRegistrySchema.parse(registry), stored === undefined ? null : expected,
      current, MISSION_TOMBSTONE_MAX_BYTES)
    return reservation
  }

  private async required(id: string): Promise<MissionDocument> {
    const doc = await this.read(id)
    if (!doc || "deletedAt" in doc) throw new Error("Mission document missing or deleted")
    return doc
  }
  private async registry() {
    const input = await this.storage.get(`${this.prefix}/tombstones`)
    return parseMissionTombstoneRegistry(input ?? { version: 1, revision: 0, entries: [] })
  }
  private key(id: string) { return `${this.prefix}/missions/${documentID.parse(id)}` }
   private exclusive<T>(work: () => Promise<T>, available = false): Promise<T> {
    if (this.borrowed) {
      try { this.borrowed(); return work().then(value => { this.borrowed!(); return value }) }
      catch (error) { return Promise.reject(error) }
    }
    return (available ? runAvailableMissionExclusive : runMissionExclusive)(`document-mutation:${this.projectToken}`, work)
  }
  private async publish(doc: MissionDocument, expected: number | null, current: () => true, prepare?: () => Promise<void>) {
    const parsed = parseMissionDocument(doc, { id: doc.id, projectID: this.projectID, projectCanonical: this.projectCanonical })
    await this.commit(this.key(doc.id), parsed, expected, current, MISSION_DOCUMENT_MAX_BYTES, prepare)
    return parsed
  }
  private async commit(key: string, input: unknown, expected: number | null, current: () => true, maxBytes = MISSION_DOCUMENT_MAX_BYTES,
    prepare?: () => Promise<void>) {
    const bytes = canonicalAuthority(input, maxBytes), fence = () => { this.borrowed?.(); return assertSynchronousAuthorityGuard(current, "policy-unqualified") }
    fence()
    // Bounded source I/O runs under document exclusion, before the short SQL CAS.
    // Only synchronous invocation/native projection guards enter the transaction.
    await prepare?.()
    fence()
    await this.storage.compareAndSet(key, JSON.parse(bytes) as MissionJsonValue, expected, fence)
    const saved = await this.storage.get(key)
    if (canonicalAuthority(saved, maxBytes) !== bytes) throw new Error("Mission document publication unknown")
    fence()
  }
}
