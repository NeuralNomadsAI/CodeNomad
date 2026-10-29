import { canonicalAuthority } from "./authority-protocol"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { runMissionExclusive } from "./exclusive"
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

/** Point reads/writes use their own namespace. Passage journals retain their
 * existing ranges, per-mission capacity, deletion reserve and activation index. */
export class NativeMissionDocumentStore {
  readonly projectToken: string
  private readonly prefix: string
  constructor(private readonly storage: MissionDocumentStorage, readonly projectID: string, readonly projectCanonical: string) {
    if (!projectID || !projectCanonical) throw new Error("Invalid Mission document project")
    this.projectToken = stableToken(`${projectID}\0${projectCanonical}`, 24)
    this.prefix = `${MISSION_DOCUMENT_PREFIX}/project/${this.projectToken}`
  }

  async read(id: string): Promise<MissionDocument | MissionDocumentTombstone | undefined> {
    const input = await this.storage.get(this.key(id))
    if (input === undefined) return undefined
    if (input && typeof input === "object" && "deletedAt" in input) {
      const result = missionTombstoneSchema.parse(input)
      if (result.id !== id || result.projectID !== this.projectID || result.projectCanonical !== this.projectCanonical)
        throw new Error("Invalid Mission tombstone identity")
      return result
    }
    return parseMissionDocument(input, { id, projectID: this.projectID, projectCanonical: this.projectCanonical })
  }

  create(id: string, configuration: MissionConfiguration, now: number, current: () => true, oneTime: MissionDocument["oneTime"] = null): Promise<MissionDocument> {
    return this.exclusive(async () => {
      if (await this.read(id) || (await this.registry()).entries.some(item => item.id === id)) throw new Error("Mission document already exists or deleted")
      const doc: MissionDocument = { version: 1, id, projectID: this.projectID, projectCanonical: this.projectCanonical,
        revision: 0, configurationGeneration: 1, timeGeneration: 1, createdAt: now,
        configuration: missionConfigurationSchema.parse(configuration), state: "paused", firstPlayedAt: null,
        oneShotAt: null, slotEndsAt: null, launchedCount: 0, settledCount: 0, everCreatedTask: false, blocked: null,
        calendars: [], synchronization: null, deletion: null, checkpoints: [], pending: null, history: [], oneTime, scheduleActivation: null }
      return this.publish(doc, null, current)
    })
  }

  change(id: string, expectedRevision: number, current: () => true, update: (document: MissionDocument) => void): Promise<MissionDocument> {
    return this.exclusive(async () => {
      const doc = await this.required(id)
      if (!Number.isSafeInteger(expectedRevision) || doc.revision !== expectedRevision) throw new Error("Mission document revision conflict")
      const previous = structuredClone(doc)
      const result = update(doc) as unknown
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result)
        throw new Error("Mission document update must be synchronous")
      if (canonicalAuthority(doc, MISSION_DOCUMENT_MAX_BYTES) === canonicalAuthority(previous, MISSION_DOCUMENT_MAX_BYTES)) {
        assertSynchronousAuthorityGuard(current, "policy-unqualified")
        return previous
      }
      if (doc.id !== previous.id || doc.projectID !== previous.projectID || doc.projectCanonical !== previous.projectCanonical
        || doc.createdAt !== previous.createdAt || previous.firstPlayedAt !== null && doc.firstPlayedAt !== previous.firstPlayedAt
        || doc.launchedCount < previous.launchedCount || doc.settledCount < previous.settledCount
        || doc.configurationGeneration < previous.configurationGeneration || doc.timeGeneration < previous.timeGeneration
        || previous.everCreatedTask && !doc.everCreatedTask || previous.deletion && canonicalAuthority(doc.deletion) !== canonicalAuthority(previous.deletion)
        || previous.oneTime?.firstPlay?.acknowledgement && canonicalAuthority(previous.oneTime.firstPlay.acknowledgement, MISSION_DOCUMENT_MAX_BYTES)
          !== canonicalAuthority(doc.oneTime?.firstPlay?.acknowledgement ?? null, MISSION_DOCUMENT_MAX_BYTES)
        || previous.state === "stopped" && doc.state !== "stopped"
        || previous.everCreatedTask && previous.configuration.template !== doc.configuration.template
        || previous.calendars.some(old => doc.calendars.some(item => item.scheduleID === old.scheduleID
          && (item.timeGeneration !== old.timeGeneration || item.sessionID !== old.sessionID || item.highWater < old.highWater))))
        throw new Error("Mission document progress is monotone")
      doc.revision = expectedRevision + 1
      return this.publish(doc, expectedRevision, current)
    })
  }

  /** Native cleanup must first reconcile every mapping/preparation/control. A
   * full registry keeps the complete stopped document visible; barriers never evict. */
  reserveDeletion(id: string, expectedRevision: number, current: () => true): Promise<void> {
    return this.exclusive(async () => {
      const doc = await this.required(id)
      if (doc.revision !== expectedRevision || !doc.deletion || doc.state !== "stopped") throw new Error("Mission deletion reconciliation pending")
      await this.reserveDeletionSlot(doc, current)
    })
  }

  compact(id: string, expectedRevision: number, now: number, current: () => true): Promise<MissionDocumentTombstone> {
    return this.exclusive(async () => {
      const existing = await this.read(id)
      if (existing && "deletedAt" in existing && existing.revision === expectedRevision + 1) return existing
      const doc = await this.required(id)
      if (doc.revision !== expectedRevision || !doc.deletion || doc.state !== "stopped"
        || doc.pending || doc.synchronization || doc.calendars.length || doc.blocked === "unknown"
        || doc.oneTime?.firstPlay && doc.oneTime.firstPlay.admittedAt === null
        || doc.scheduleActivation?.targets.some(target => target.attempted && !target.acknowledged)) throw new Error("Mission deletion reconciliation pending")
      const reservation = await this.reserveDeletionSlot(doc, current)
      const tombstone = missionTombstoneSchema.parse({ version: 1, id, projectID: this.projectID, projectCanonical: this.projectCanonical,
        revision: expectedRevision + 1, requestID: doc.deletion.requestID, expectedRevision: doc.deletion.expectedRevision,
        deleteManagedSessions: doc.deletion.deleteManagedSessions, deletedAt: reservation.deletedAt, timeGeneration: doc.timeGeneration })
      await this.commit(this.key(id), tombstone, expectedRevision, current)
      return tombstone
    })
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
  private exclusive<T>(work: () => Promise<T>): Promise<T> { return runMissionExclusive(`document-mutation:${this.projectToken}`, work) }
  private async publish(doc: MissionDocument, expected: number | null, current: () => true) {
    const parsed = parseMissionDocument(doc, { id: doc.id, projectID: this.projectID, projectCanonical: this.projectCanonical })
    await this.commit(this.key(doc.id), parsed, expected, current)
    return parsed
  }
  private async commit(key: string, input: unknown, expected: number | null, current: () => true, maxBytes = MISSION_DOCUMENT_MAX_BYTES) {
    const bytes = canonicalAuthority(input, maxBytes), fence = () => assertSynchronousAuthorityGuard(current, "policy-unqualified")
    fence()
    await this.storage.compareAndSet(key, JSON.parse(bytes) as MissionJsonValue, expected, fence)
    const saved = await this.storage.get(key)
    if (canonicalAuthority(saved, maxBytes) !== bytes) throw new Error("Mission document publication unknown")
    fence()
  }
}
