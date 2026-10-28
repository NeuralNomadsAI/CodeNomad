import { controlReceiptID, hasInvalidControlHistory, isControlReceipt, recurrenceMessageID, stableToken } from "./receipt-identity"
export { stableToken } from "./receipt-identity"

import {
  MISSION_MAX_EVENTS,
  MISSION_MAX_STORED_EVENTS,
  MISSION_MAX_ACTORS,
  MISSION_MAX_TASKS,
  MISSION_SCHEMA_VERSION,
  reduceMissionEvents,
  compareEvents,
  type MissionEvent,
  type MissionJsonValue,
  type MissionLocation,
  type MissionMap,
  type MissionReport,
  type MissionRevisedEvent,
  type MissionSnapshot,
  type MissionTemplateId,
} from "./model"
import { runMissionExclusive } from "./exclusive"
import { parseMissionBriefing } from "./briefing"
import { parseExecution } from "./execution"
import { parseExecutionMode } from "./task-execution-mode"
import { hasInvalidReportNotificationHistory, parseNativeBinding, parseNativeCall } from "./native-report-provenance"
import { parseMissionNativeAcknowledgement } from "./lifecycle-schema"
import { parseMissionProfiles, validateMissionProfiles } from "./playbook-profiles"
import { parseMissionTitle } from "./mission-title"
import { missionTaskModeInputSchema } from "./task-execution-mode"
import { parseNativeCallObservation } from "./native-call-observation"
import { nativeCallObservationID } from "./native-call-reconciliation"
import { SETTLED_CLEANUP_HISTORY, cleanupReceiptID, hasInvalidCleanupHistory, isCleanupReason, isCleanupReceipt, projectMissionCleanups } from "./cleanup-projection"
import { parseDeletionRecord, planDeletionPurge, type MissionDeletionRecord } from "./journal-purge"

// Storage generation, independent of the event wire/schema version. No legacy reads.
export const MISSION_JOURNAL_STORAGE_PREFIX = "codenomad-missions/v2"
const PAGE_SIZE = 100
const MAX_TEXT = 20_000
const MAX_SHORT_TEXT = 240
type CapacityIntent = Extract<MissionEvent, { type: "mission.deleted" | "mission.control-requested" }>
interface CapacitySlot { intent: CapacityIntent; sessionID: string }
interface Observation { events: MissionEvent[]; discardedEvents: number; purged: MissionEvent[] }

/** One mission's range reduced like a snapshot: `mission` is absent when the
 * range holds no live map (deleted, purged, damaged or unknown). */
export interface MissionView extends Omit<MissionSnapshot, "missions"> {
  missionID: string
  mission?: MissionMap
  events: MissionEvent[]
}

export interface MissionStorage {
  get(key: string): Promise<MissionJsonValue | undefined>
  /** Async adapters repeat current after preparation; not a native commit proof. */
  set(key: string, value: MissionJsonValue, current?: () => void): Promise<void>
  /** Purge-capable storage only; without it settled deletions stay in the journal. */
  remove?(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: readonly { key: string; value: MissionJsonValue }[]
    next?: string
  }>
}

export class MissionJournal {
  readonly projectToken: string

  constructor(
    private readonly storage: MissionStorage,
    private readonly projectID: string,
    projectCanonical: string,
    private readonly now: () => number = Date.now,
  ) {
    this.projectToken = stableToken(`${projectID}\0${projectCanonical}`, 24)
  }

  /** A paginated scan must not straddle a purge's removals, so observations take
   * the append exclusion (FIFO, shared by bundle incarnations). Holders of that
   * exclusion use `observe`; storage adapters must never read the journal. */
  async events(): Promise<{ events: MissionEvent[]; discardedEvents: number }> {
    const { events, discardedEvents } = await runMissionExclusive(`append:${this.projectToken}`, () => this.observe())
    return { events, discardedEvents }
  }

  /** One mission's share of `events()`: its key range `<prefix>/<missionID>/`,
   * read under the same exclusion, parsing, bound and purge resolution. Entries
   * outside every mission range count only in the project observation. */
  async missionEvents(missionID: string): Promise<{ events: MissionEvent[]; discardedEvents: number }> {
    const { events, discardedEvents } = await runMissionExclusive(`append:${this.projectToken}`, () => this.observeMission(missionID))
    return { events, discardedEvents }
  }

  /** One mission's share of `snapshot()`, reduced from its range alone. Its
   * damage flags and discarded count are this range's own; the project values are
   * their aggregate plus damage outside every mission range. */
  async missionView(missionID: string): Promise<MissionView> {
    const { events, discardedEvents } = await this.missionEvents(missionID)
    const { missions: [mission], ...view } = this.reduce(events, discardedEvents)
    return { ...view, missionID, ...(mission ? { mission } : {}), events }
  }

  private async observeMission(missionID: string): Promise<Observation> {
    // No unsafe ID owns a range: entries there never parse as events.
    return isSafeKey(missionID) ? this.observe(`${this.prefix()}/${missionID}/`) : { events: [], discardedEvents: 0, purged: [] }
  }

  /** A group without its creation event whose mission left a deletion record is
   * a purge in progress (or a late write after it): it leaves the observation.
   * Every other incomplete group remains damage evidence. */
  private async observe(prefix = this.prefix()): Promise<Observation> {
    const events: MissionEvent[] = []
    let discardedEvents = 0
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix, after, limit: PAGE_SIZE })
      for (const entry of page.entries) {
        if (events.length + discardedEvents >= MISSION_MAX_STORED_EVENTS) {
          throw new Error(`Mission journal exceeds the ${MISSION_MAX_STORED_EVENTS}-event safety limit`)
        }
        const event = this.parseEntry(entry.key, entry.value)
        if (!event) discardedEvents += 1
        else events.push(event)
      }
      after = page.next
    } while (after)

    const created = new Set(events.flatMap(event => event.type === "mission.created" ? [event.missionID] : []))
    const purged = new Set<string>()
    for (const missionID of new Set(events.map(event => event.missionID))) {
      // Unreadable records keep the group as damage, never as proof of a purge.
      if (!created.has(missionID) && await this.readRecord(missionID).catch(() => undefined)) purged.add(missionID)
    }
    return { events: events.filter(event => !purged.has(event.missionID)), discardedEvents,
      purged: events.filter(event => purged.has(event.missionID)) }
  }

  /** The record a purged deleted mission leaves. Read on every storage: only
   * purging and the deletion reserve need removal support. */
  async deletionRecord(missionID: string): Promise<MissionDeletionRecord | undefined> {
    return isSafeKey(missionID) ? this.readRecord(missionID) : undefined
  }

  /** Removes settled deleted missions beyond the recent cleanup history (all of
   * them when `all`), plus leftovers of interrupted purges. Returns removed entries. */
  purgeDeleted(options: { all?: boolean } = {}): Promise<number> {
    return runMissionExclusive(`append:${this.projectToken}`, () => this.purgeUnlocked(options.all ?? false))
  }

  private async purgeUnlocked(all: boolean): Promise<number> {
    const storage = this.storage
    if (!storage.remove) return 0
    const { events, discardedEvents, purged } = await this.observe()
    let removed = 0
    for (const event of purged) { await storage.remove(this.eventKey(event.missionID, event.id)); removed++ }
    // Damaged storage cannot establish settled cleanup, receipts or membership.
    if (discardedEvents || hasInvalidCleanupHistory(events) || hasInvalidControlHistory(events)
      || hasInvalidReportNotificationHistory(events)) return removed
    for (const purge of planDeletionPurge(events, all ? 0 : SETTLED_CLEANUP_HISTORY)) {
      // The record is durable before the first removal and never removed.
      const key = this.recordKey(purge.missionID)
      const existing = await storage.get(key)
      if (existing === undefined) await storage.set(key, purge.record as unknown as MissionJsonValue)
      else if (parseDeletionRecord(existing, this.projectID, purge.missionID)?.deletionID !== purge.record.deletionID) continue
      for (const event of purge.events) { await storage.remove(this.eventKey(event.missionID, event.id)); removed++ }
    }
    return removed
  }

  private async readRecord(missionID: string): Promise<MissionDeletionRecord | undefined> {
    const value = await this.storage.get(this.recordKey(missionID))
    if (value === undefined) return undefined
    const record = parseDeletionRecord(value, this.projectID, missionID)
    if (!record) throw new Error("Mission deletion record is damaged")
    return record
  }

  async snapshot(): Promise<MissionSnapshot> {
    const { events, discardedEvents } = await this.events()
    return this.reduce(events, discardedEvents)
  }

  private reduce(events: readonly MissionEvent[], discardedEvents: number): MissionSnapshot {
    const snapshot = reduceMissionEvents(events, this.now())
    snapshot.projectID = this.projectID
    snapshot.discardedEvents += discardedEvents
    // Damaged storage cannot establish complete pending/settled intent.
    snapshot.cleanups = projectMissionCleanups(events)
    if (discardedEvents || hasInvalidCleanupHistory(events)) snapshot.cleanupUnavailable = true
    if (discardedEvents || hasInvalidControlHistory(events)) snapshot.controlUnavailable = true
    if (discardedEvents || hasInvalidReportNotificationHistory(events)) snapshot.notificationUnavailable = true
    for (const mission of snapshot.missions) {
      if (snapshot.controlUnavailable) mission.controlUnavailable = true
      if (snapshot.notificationUnavailable) mission.notificationUnavailable = true
    }
    return snapshot
  }

  append(event: MissionEvent, current?: () => void): Promise<void> {
    return runMissionExclusive(`append:${this.projectToken}`, () => this.appendUnlocked(event, current))
  }

  async event(missionID: string, eventID: string): Promise<MissionEvent | undefined> {
    const key = this.eventKey(missionID, eventID)
    const value = await this.storage.get(key)
    if (value === undefined) return undefined
    const parsed = this.parseEntry(key, value)
    if (!parsed) {
      throw new Error("Mission event storage identity mismatch")
    }
    return parsed
  }

  async assertCanAppend(count: number | MissionEvent = 1): Promise<void> {
    const event = typeof count === "number" ? undefined
      : this.parseEntry(this.eventKey(count.missionID, count.id), JSON.parse(JSON.stringify(count)))
    if (typeof count !== "number" && !event) throw new Error("Mission event is not durable owned JSON")
    const request = event ?? count as number
    if (await this.fits(request)) return
    if (this.storage.remove && await this.purgeDeleted({ all: true }) && await this.fits(request)) return
    throw new Error(`Mission journal reached the ${MISSION_MAX_EVENTS}-event safety limit`)
  }

  private async fits(request: MissionEvent | number): Promise<boolean> {
    const capacity = await this.storedCapacity()
    const slots = capacity.cleanupSlots
    const required = typeof request === "number" ? request : this.requiredCapacity(request, slots)
    // Deletion intents and already reserved receipts may spend the deletion reserve.
    const limit = this.storage.remove && typeof request !== "number"
      && (request.type === "mission.deleted" || this.matchesCapacityReceipt(request, slots)) ? MISSION_MAX_STORED_EVENTS : MISSION_MAX_EVENTS
    return capacity.count + slots.size + required <= limit
  }

  private async appendUnlocked(event: MissionEvent, current?: () => void): Promise<void> {
    if (event.projectID !== this.projectID) throw new Error("Mission event belongs to another project")
    const normalized = JSON.parse(JSON.stringify(event)) as unknown
    const parsed = parseMissionEvent(normalized)
    if (!parsed) throw new Error("Mission event is not durable JSON")
    const stored = JSON.parse(JSON.stringify(parsed)) as MissionJsonValue
    const key = this.eventKey(parsed.missionID, parsed.id)
    const existing = await this.storage.get(key)
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(stored)) throw new Error("Mission event identity collision")
      return
    }
    if (!await this.fits(parsed) && !(this.storage.remove && await this.purgeUnlocked(true) && await this.fits(parsed))) {
      throw new Error(`Mission journal reached the ${MISSION_MAX_EVENTS}-event safety limit`)
    }
    current?.()
    await this.storage.set(key, stored, current)
  }

  private requiredCapacity(event: MissionEvent, slots: Map<string, CapacitySlot>): number {
    if (this.matchesCapacityReceipt(event, slots)) return 0
    // A newer Stop replaces only this mission's pending start/pause slots.
    // Physical events, cleanup reservations and other missions remain counted.
    const superseded = event.type === "mission.control-requested" && event.action === "stop"
      ? [...slots.values()].filter(({ intent }) => intent.type === "mission.control-requested" && intent.action !== "stop"
        && intent.projectID === event.projectID && intent.missionID === event.missionID
        && event.expectedRevision > intent.expectedRevision
        && compareEvents(event, intent) > 0).length : 0
    return 1 + (event.type === "mission.deleted" ? event.cleanupTargets?.length ?? 0 : 0)
      + (event.type === "mission.control-requested" ? event.targets.length : 0) - superseded
  }

  private async storedCapacity(): Promise<{ count: number; cleanupSlots: Map<string, CapacitySlot> }> {
    let count = 0
    // Physical deterministic receipt keys include mission scope. Retain the
    // original intent/target as well: a different event kind cannot spend them.
    const cleanupSlots = new Map<string, CapacitySlot>()
    const receipts: MissionEvent[] = []
    const latestControls = new Map<string, Extract<MissionEvent, { type: "mission.control-requested" }>>()
    const reserve = (intent: CapacityIntent, sessionID: string) => {
      const id = intent.type === "mission.deleted" ? cleanupReceiptID(intent.id, sessionID)
        : controlReceiptID(intent.id, sessionID)
      cleanupSlots.set(this.eventKey(intent.missionID, id), { intent, sessionID })
    }
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix: this.prefix(), after, limit: PAGE_SIZE })
      count += page.entries.length
      if (count > MISSION_MAX_STORED_EVENTS) throw new Error(`Mission journal exceeds the ${MISSION_MAX_STORED_EVENTS}-event safety limit`)
      for (const entry of page.entries) {
        // Invalid entries still consume physical space, but supply no authority
        // to establish, supersede or discharge a reservation.
        const event = this.parseEntry(entry.key, entry.value)
        if (event?.type === "mission.deleted") {
          for (const target of event.cleanupTargets ?? []) reserve(event, target.sessionID)
        } else if (event?.type === "mission.session-cleaned") receipts.push(event)
        else if (event?.type === "mission.control-requested") {
          const previous = latestControls.get(event.missionID)
          if (!previous || compareEvents(event, previous) > 0) latestControls.set(event.missionID, event)
        } else if (event?.type === "mission.control-applied") receipts.push(event)
      }
      after = page.next
    } while (after)
    for (const operation of latestControls.values()) {
      for (const target of operation.targets) reserve(operation, target.sessionID)
    }
    for (const receipt of receipts) if (this.matchesCapacityReceipt(receipt, cleanupSlots)) cleanupSlots.delete(this.eventKey(receipt.missionID, receipt.id))
    return { count, cleanupSlots }
  }

  private matchesCapacityReceipt(event: MissionEvent, slots: Map<string, CapacitySlot>): boolean {
    const slot = slots.get(this.eventKey(event.missionID, event.id))
    if (!slot) return false
    const { intent, sessionID } = slot
    return intent.type === "mission.deleted" ? isCleanupReceipt(event, intent, sessionID)
      : isControlReceipt(event, intent, sessionID)
  }

  private parseEntry(key: string, value: unknown): MissionEvent | undefined {
    const event = parseMissionEvent(value)
    return event && event.projectID === this.projectID && isSafeKey(event.missionID) && isSafeKey(event.id)
      && key === this.eventKey(event.missionID, event.id) ? event : undefined
  }

  private eventKey(missionID: string, eventID: string): string {
    return `${this.prefix()}/${safeKey(missionID)}/${safeKey(eventID)}`
  }

  private prefix(): string {
    return `${MISSION_JOURNAL_STORAGE_PREFIX}/${this.projectToken}`
  }

  private recordKey(missionID: string): string {
    return missionDeletionRecordKey(this.projectToken, missionID)
  }
}

// Beside, never under, the scanned journal prefix: records cost no journal capacity.
export function missionDeletionRecordKey(projectToken: string, missionID: string): string {
  return `${MISSION_JOURNAL_STORAGE_PREFIX}/deleted/${projectToken}/${safeKey(missionID)}`
}

function safeKey(value: string): string {
  if (!isSafeKey(value)) throw new Error("Mission journal key is invalid")
  return value
}

function isSafeKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{3,100}$/.test(value)
}

export function parseMissionEvent(input: unknown): MissionEvent | undefined {
  if (!record(input) || input.version !== MISSION_SCHEMA_VERSION || !baseEvent(input)) return undefined
  switch (input.type) {
    case "mission.briefed": {
      const briefing = parseMissionBriefing(input.briefing)
      if (!briefing || !text(input.actorSessionID, MAX_SHORT_TEXT) || briefing.id !== input.id || briefing.createdAt !== input.createdAt) return undefined
      return { ...eventBase(input), type: "mission.briefed", actorSessionID: input.actorSessionID, briefing }
    }
    case "mission.created": {
      const templateID = input.template
      if (!text(input.projectCanonical, MAX_TEXT) || !text(input.objective, MAX_TEXT)
        || !template(templateID) || !record(input.coordinator)) return undefined
      const location = parseLocation(input.coordinator.location)
      if (!location || !text(input.coordinator.sessionID, MAX_SHORT_TEXT)
        || !text(input.coordinator.title, MAX_SHORT_TEXT)) return undefined
      if (input.notes !== undefined && !boundedText(input.notes, MAX_TEXT)) return undefined
      if (input.title !== undefined && parseMissionTitle(input.title) !== input.title) return undefined
      if (input.prepared !== undefined && typeof input.prepared !== "boolean") return undefined
      const preparedBy = input.preparedBy
      if (preparedBy !== undefined && (!record(preparedBy) || !onlyFields(preparedBy, ["missionID", "coordinatorSessionID"])
        || !text(preparedBy.missionID, MAX_SHORT_TEXT) || !text(preparedBy.coordinatorSessionID, MAX_SHORT_TEXT))) return undefined
      if (input.taskMode !== undefined && !missionTaskModeInputSchema.safeParse(input.taskMode).success) return undefined
      let profiles
      try { profiles = parseMissionProfiles(input.profiles); validateMissionProfiles(templateID, profiles) }
      catch { return undefined }
      return {
        ...eventBase(input),
        type: "mission.created",
        projectCanonical: input.projectCanonical,
        ...(input.title === undefined ? {} : { title: input.title as string }),
        objective: input.objective,
        notes: input.notes as string | undefined,
        template: templateID,
        ...(input.taskMode === undefined ? {} : { taskMode: missionTaskModeInputSchema.parse(input.taskMode) }),
        ...(profiles === undefined ? {} : { profiles }),
        coordinator: {
          sessionID: input.coordinator.sessionID,
          title: input.coordinator.title,
          location,
        },
        ...(input.requestID === undefined ? {} : { requestID: input.requestID as string }),
        ...(input.prepared === undefined ? {} : { prepared: input.prepared as boolean }),
        ...(preparedBy === undefined ? {} : { preparedBy: { missionID: preparedBy.missionID as string,
          coordinatorSessionID: preparedBy.coordinatorSessionID as string } }),
      }
    }
    case "mission.control-requested": {
      if (!text(input.requestID, 128) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1
        || !["start", "pause", "stop"].includes(String(input.action)) || !Array.isArray(input.targets) || input.targets.length > MISSION_MAX_ACTORS || !input.targets.length) return undefined
      const targets: Array<{ sessionID: string; location: MissionLocation }> = []
      const recurrence = input.recurrence
      if (recurrence !== undefined && (!record(recurrence) || input.action !== "start"
        || !text(recurrence.grantID, MAX_SHORT_TEXT) || !text(recurrence.passageID, MAX_SHORT_TEXT)
        || !text(recurrence.messageID, MAX_SHORT_TEXT) || !text(recurrence.coordinatorSessionID, MAX_SHORT_TEXT)
        || recurrence.passageID !== input.requestID
        || recurrence.messageID !== recurrenceMessageID(recurrence.passageID))) return undefined
      for (const target of input.targets) {
        if (!record(target) || !text(target.sessionID, MAX_SHORT_TEXT)) return undefined
        const location = parseLocation(target.location)
        if (!location || targets.some(item => item.sessionID === target.sessionID)) return undefined
        targets.push({ sessionID: target.sessionID, location })
      }
      if (recurrence !== undefined && (targets.length !== 1 || targets[0].sessionID !== recurrence.coordinatorSessionID)) return undefined
      return { ...eventBase(input), type: "mission.control-requested", requestID: input.requestID, expectedRevision: Number(input.expectedRevision), action: input.action as "start" | "pause" | "stop", targets,
        ...(recurrence === undefined ? {} : { recurrence: { grantID: recurrence.grantID as string, passageID: recurrence.passageID as string,
          messageID: recurrence.messageID as string, coordinatorSessionID: recurrence.coordinatorSessionID as string } }) }
    }
    case "mission.control-applied": {
      if (!text(input.operationID, MAX_SHORT_TEXT) || !text(input.sessionID, MAX_SHORT_TEXT)) return undefined
      const nativeAcknowledgement = input.nativeAcknowledgement === undefined ? undefined
        : parseMissionNativeAcknowledgement(input.nativeAcknowledgement)
      if (input.nativeAcknowledgement !== undefined && (!nativeAcknowledgement
        || nativeAcknowledgement.missionID !== input.missionID || nativeAcknowledgement.operationID !== input.operationID
        || nativeAcknowledgement.sessionID !== input.sessionID)) return undefined
      return { ...eventBase(input), type: "mission.control-applied", operationID: input.operationID, sessionID: input.sessionID,
        ...(nativeAcknowledgement === undefined ? {} : { nativeAcknowledgement }) }
    }
    case "mission.updated":
      if (!text(input.requestID, 128) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1
        || typeof input.notesSpecified !== "boolean" || !text(input.objective, MAX_TEXT)
        || (input.notes !== undefined && !boundedText(input.notes, MAX_TEXT))) return undefined
      return { ...eventBase(input), type: "mission.updated", requestID: input.requestID, expectedRevision: Number(input.expectedRevision), notesSpecified: input.notesSpecified, objective: input.objective, notes: input.notes as string | undefined }
    case "mission.deleted": {
      if (!text(input.requestID, 128) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) return undefined
      if (input.deleteManagedSessions !== undefined && typeof input.deleteManagedSessions !== "boolean") return undefined
      const cleanupTargets: Array<{ sessionID: string; location: MissionLocation }> = []
      if (input.cleanupTargets !== undefined) {
        if (input.deleteManagedSessions !== true || !Array.isArray(input.cleanupTargets) || input.cleanupTargets.length > MISSION_MAX_ACTORS) return undefined
        for (const target of input.cleanupTargets) {
          if (!record(target) || !text(target.sessionID, MAX_SHORT_TEXT)) return undefined
          const location = parseLocation(target.location)
          if (!location || cleanupTargets.some((entry) => entry.sessionID === target.sessionID)) return undefined
          cleanupTargets.push({ sessionID: target.sessionID, location })
        }
      }
      if (input.deleteManagedSessions === true && input.cleanupTargets === undefined) return undefined
      return {
        ...eventBase(input), type: "mission.deleted", requestID: input.requestID, expectedRevision: Number(input.expectedRevision),
        ...(input.deleteManagedSessions === undefined ? {} : { deleteManagedSessions: input.deleteManagedSessions }),
        ...(input.cleanupTargets === undefined ? {} : { cleanupTargets }),
      }
    }
    case "mission.session-cleaned":
      if (!text(input.deletionID, MAX_SHORT_TEXT) || !text(input.sessionID, MAX_SHORT_TEXT)
        || (input.outcome !== "removed" && input.outcome !== "retained")) return undefined
      return { ...eventBase(input), type: "mission.session-cleaned", deletionID: input.deletionID, sessionID: input.sessionID, outcome: input.outcome,
        ...(input.outcome === "retained" && isCleanupReason(input.reason) ? { reason: input.reason } : {}) }
    case "mission.revised": {
      if (!text(input.requestID, 128) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1
        || !text(input.actorSessionID, MAX_SHORT_TEXT) || !text(input.reason, 2_000)
        || (input.objective !== undefined && !text(input.objective, MAX_TEXT))
        || typeof input.notesSpecified !== "boolean"
        || (input.notes !== undefined && !boundedText(input.notes, MAX_TEXT))
        || !Array.isArray(input.retiredTasks) || input.retiredTasks.length > 24
        || !Array.isArray(input.addedTasks) || input.addedTasks.length > 24
        || !Array.isArray(input.dependencyUpdates) || input.dependencyUpdates.length > MISSION_MAX_TASKS) return undefined
      const retiredTasks: MissionRevisedEvent["retiredTasks"] = []
      for (const retired of input.retiredTasks) {
        if (!record(retired) || !text(retired.taskKey, MAX_SHORT_TEXT)
          || (retired.replacementTaskKey !== undefined && !text(retired.replacementTaskKey, MAX_SHORT_TEXT))) return undefined
        retiredTasks.push({ taskKey: retired.taskKey, ...(retired.replacementTaskKey === undefined ? {} : { replacementTaskKey: retired.replacementTaskKey }) })
      }
      const addedTasks: MissionRevisedEvent["addedTasks"] = []
      for (const added of input.addedTasks) {
        if (!record(added) || !text(added.id, MAX_SHORT_TEXT) || !text(added.key, MAX_SHORT_TEXT)
          || !onlyFields(added, ["id", "key", "title", "brief", "role", "execution", "executionMode", "blockedBy", "replacesTaskKey"])
          || !text(added.title, MAX_SHORT_TEXT) || !text(added.brief, MAX_TEXT) || !text(added.role, MAX_SHORT_TEXT)
          || (added.replacesTaskKey !== undefined && !text(added.replacesTaskKey, MAX_SHORT_TEXT))
          || !stringArray(added.blockedBy, 24, MAX_SHORT_TEXT)) return undefined
        let execution
        let executionMode
        try { execution = parseExecution(added.execution); executionMode = parseExecutionMode(added.executionMode) } catch { return undefined }
        addedTasks.push({
          id: added.id, key: added.key, title: added.title, brief: added.brief, role: added.role,
          ...(execution === undefined ? {} : { execution }), blockedBy: added.blockedBy,
          ...(added.replacesTaskKey === undefined ? {} : { replacesTaskKey: added.replacesTaskKey }),
          ...(executionMode === undefined ? {} : { executionMode }),
        })
      }
      const dependencyUpdates: MissionRevisedEvent["dependencyUpdates"] = []
      for (const update of input.dependencyUpdates) {
        if (!record(update) || !onlyFields(update, ["taskKey", "blockedBy"])
          || !text(update.taskKey, MAX_SHORT_TEXT) || !stringArray(update.blockedBy, 24, MAX_SHORT_TEXT)) return undefined
        dependencyUpdates.push({ taskKey: update.taskKey, blockedBy: update.blockedBy })
      }
      return {
        ...eventBase(input), type: "mission.revised", requestID: input.requestID,
        expectedRevision: Number(input.expectedRevision), actorSessionID: input.actorSessionID,
        reason: input.reason, objective: input.objective as string | undefined,
        notesSpecified: input.notesSpecified, notes: input.notes as string | undefined,
        retiredTasks, addedTasks, dependencyUpdates,
      }
    }
    case "task.created": {
      if (!record(input.task) || !text(input.task.id, MAX_SHORT_TEXT) || !text(input.task.key, MAX_SHORT_TEXT)
        || !onlyFields(input.task, ["id", "key", "title", "brief", "role", "execution", "executionMode", "blockedBy"])
        || !text(input.task.title, MAX_SHORT_TEXT) || !text(input.task.brief, MAX_TEXT)
        || !text(input.task.role, MAX_SHORT_TEXT) || !stringArray(input.task.blockedBy, 24, MAX_SHORT_TEXT)) return undefined
      let execution
      let executionMode
      try { execution = parseExecution(input.task.execution); executionMode = parseExecutionMode(input.task.executionMode) } catch { return undefined }
      return {
        ...eventBase(input),
        type: "task.created",
        task: {
          id: input.task.id,
          key: input.task.key,
          title: input.task.title,
          brief: input.task.brief,
          role: input.task.role,
          ...(execution === undefined ? {} : { execution }),
          ...(executionMode === undefined ? {} : { executionMode }),
          blockedBy: input.task.blockedBy,
        },
      }
    }
    case "task.native-bound": {
      if (!onlyFields(input, ["version", "id", "missionID", "projectID", "createdAt", "type", "taskKey", "actor", "binding"])
        || !text(input.taskKey, MAX_SHORT_TEXT) || !record(input.actor)
        || !onlyFields(input.actor, ["sessionID", "title", "location", "managed"])
        || !nativeID(input.actor.sessionID) || !text(input.actor.title, MAX_SHORT_TEXT)
        || typeof input.actor.managed !== "boolean") return undefined
      const binding = parseNativeBinding(input.binding)
      const location = parseLocation(input.actor.location)
      if (!binding || !location || !onlyFields(input.actor.location, ["directory", "workspaceID"])) return undefined
      return {
        ...eventBase(input), type: "task.native-bound", taskKey: input.taskKey,
        actor: { sessionID: input.actor.sessionID, title: input.actor.title, location, managed: input.actor.managed }, binding,
      }
    }
    case "task.native-call-observed": {
      if (!onlyFields(input, ["version", "id", "missionID", "projectID", "createdAt", "type", "taskKey", "binding", "childSessionID", "observation"])
        || !text(input.taskKey, MAX_SHORT_TEXT) || !nativeID(input.childSessionID)) return undefined
      const binding = parseNativeBinding(input.binding), observation = parseNativeCallObservation(input.observation)
      if (!binding || !observation || input.id !== nativeCallObservationID({ projectID: input.projectID, missionID: input.missionID,
        taskKey: input.taskKey, binding, childSessionID: input.childSessionID }, observation)) return undefined
      return { ...eventBase(input), type: "task.native-call-observed", taskKey: input.taskKey,
        binding, childSessionID: input.childSessionID, observation }
    }
    case "task.native-returned":
    case "task.native-call-started":
    case "task.native-call-ended": {
      if (!onlyFields(input, ["version", "id", "missionID", "projectID", "createdAt", "type", "taskKey", "binding", "childSessionID",
        ...(input.type === "task.native-call-ended" ? ["outcome"] : [])])
        || !text(input.taskKey, MAX_SHORT_TEXT) || !nativeID(input.childSessionID)) return undefined
      const binding = parseNativeBinding(input.binding)
      if (!binding) return undefined
      if (input.type === "task.native-call-ended") {
        if (input.outcome !== "returned" && input.outcome !== "error") return undefined
        return { ...eventBase(input), type: input.type, taskKey: input.taskKey, binding, childSessionID: input.childSessionID, outcome: input.outcome }
      }
      return { ...eventBase(input), type: input.type, taskKey: input.taskKey, binding, childSessionID: input.childSessionID }
    }
    case "task.dispatching": {
      if (!text(input.taskKey, MAX_SHORT_TEXT) || !record(input.actor)
        || !text(input.actor.sessionID, MAX_SHORT_TEXT) || !text(input.actor.title, MAX_SHORT_TEXT)
        || typeof input.actor.managed !== "boolean"
        || !text(input.admissionID, MAX_SHORT_TEXT) || !delivery(input.delivery)) return undefined
      const location = parseLocation(input.actor.location)
      if (!location) return undefined
      return {
        ...eventBase(input), type: "task.dispatching", taskKey: input.taskKey,
        actor: { sessionID: input.actor.sessionID, title: input.actor.title, location, managed: input.actor.managed },
        admissionID: input.admissionID, delivery: input.delivery,
      }
    }
    case "task.dispatched":
      return text(input.taskKey, MAX_SHORT_TEXT)
        ? { ...eventBase(input), type: "task.dispatched", taskKey: input.taskKey }
        : undefined
    case "task.reported": {
      const report = parseReport(input.report)
      return report ? { ...eventBase(input), type: "task.reported", report } : undefined
    }
    case "report.notified":
      // Preserve historical wrong-kind receipt evidence for slot validation,
      // but never accept native routing/provenance or derived state here.
      return !["nativeCall", "delivery", "binding", "generation", "nativeReturned", "notificationStatus", "outcome"]
        .some(field => Object.prototype.hasOwnProperty.call(input, field))
        && text(input.reportID, MAX_SHORT_TEXT) && text(input.admissionID, MAX_SHORT_TEXT)
        ? { ...eventBase(input), type: "report.notified", reportID: input.reportID, admissionID: input.admissionID }
        : undefined
    case "mission.reopened":
      return onlyFields(input, ["version", "id", "type", "missionID", "projectID", "createdAt", "expectedRevision"])
        && Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) >= 1
        ? { ...eventBase(input), type: "mission.reopened", expectedRevision: Number(input.expectedRevision) }
        : undefined
    case "mission.finished": {
      const failure = input.nativeFailure
      if (failure !== undefined && (input.outcome !== "failed" || !record(failure)
        || !onlyFields(failure, ["operationID", "sessionID", "messageID", "evidenceID", "inputDigest"])
        || !nativeID(failure.operationID) || !nativeID(failure.sessionID)
        || !nativeID(failure.messageID) || !nativeID(failure.evidenceID)
        || typeof failure.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(failure.inputDigest))) return undefined
      return (input.outcome === "completed" || input.outcome === "failed") && text(input.summary, MAX_TEXT)
        ? { ...eventBase(input), type: "mission.finished", outcome: input.outcome, summary: input.summary,
          ...(failure === undefined ? {} : { nativeFailure: { operationID: failure.operationID as string,
            sessionID: failure.sessionID as string, messageID: failure.messageID as string, evidenceID: failure.evidenceID as string,
            inputDigest: failure.inputDigest as string } }) }
        : undefined
    }
    default:
      return undefined
  }
}

function nativeID(value: unknown): value is string {
  return text(value, MAX_SHORT_TEXT) && !/[\s\x00-\x1f\x7f]/.test(value)
}

function onlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every(key => fields.includes(key))
}

function parseReport(input: unknown): MissionReport | undefined {
  if (!record(input) || !text(input.id, MAX_SHORT_TEXT) || !text(input.taskKey, MAX_SHORT_TEXT)
    || !onlyFields(input, ["id", "taskKey", "sessionId", "outcome", "summary", "evidence", "next", "artifact", "late", "nativeCall", "delivery", "createdAt"])
    || !text(input.sessionId, MAX_SHORT_TEXT) || !text(input.summary, MAX_TEXT)
    || !["completed", "blocked", "failed"].includes(String(input.outcome))
    || !stringArray(input.evidence, 12, 2_000) || !stringArray(input.next, 12, 2_000)
    || !Number.isSafeInteger(input.createdAt) || Number(input.createdAt) <= 0
    || (input.artifact !== undefined && !isJsonValue(input.artifact))
    || (input.late !== undefined && typeof input.late !== "boolean")
    || (input.delivery !== undefined && input.delivery !== "coordinator-notification" && input.delivery !== "native-return"
      && input.delivery !== "coordinator-readout")) return undefined
  let nativeCall
  try { nativeCall = parseNativeCall(input.nativeCall) } catch { return undefined }
  return {
    id: input.id,
    taskKey: input.taskKey,
    sessionId: input.sessionId,
    outcome: input.outcome as MissionReport["outcome"],
    summary: input.summary,
    evidence: input.evidence,
    next: input.next,
    artifact: input.artifact,
    ...(input.late === undefined ? {} : { late: input.late }),
    ...(nativeCall === undefined ? {} : { nativeCall }),
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    createdAt: Number(input.createdAt),
  }
}

function baseEvent(value: Record<string, unknown>): boolean {
  return text(value.id, MAX_SHORT_TEXT) && text(value.missionID, MAX_SHORT_TEXT)
    && text(value.projectID, MAX_SHORT_TEXT) && Number.isSafeInteger(value.createdAt) && Number(value.createdAt) > 0
}

function eventBase(value: Record<string, unknown>) {
  return {
    version: MISSION_SCHEMA_VERSION,
    id: value.id as string,
    missionID: value.missionID as string,
    projectID: value.projectID as string,
    createdAt: Number(value.createdAt),
  }
}

function parseLocation(input: unknown): MissionLocation | undefined {
  if (!record(input) || !text(input.directory, MAX_TEXT)) return undefined
  if (input.workspaceID !== undefined && !text(input.workspaceID, MAX_SHORT_TEXT)) return undefined
  return input.workspaceID === undefined
    ? { directory: input.directory }
    : { directory: input.directory, workspaceID: input.workspaceID as string }
}

function template(value: unknown): value is MissionTemplateId {
  return value === "custom" || value === "debug" || value === "wayfinder" || value === "delivery" || value === "compare"
}

function delivery(value: unknown): value is "queue" | "steer" {
  return value === "queue" || value === "steer"
}

function stringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => text(item, maxLength))
}

function text(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown, depth = 0): value is MissionJsonValue {
  if (value === undefined) return false
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (depth >= 20) return false
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1))
  return record(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1))
}
