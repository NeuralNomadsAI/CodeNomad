import { createHash } from "node:crypto"

import {
  MISSION_MAX_EVENTS,
  MISSION_MAX_ACTORS,
  MISSION_MAX_TASKS,
  MISSION_SCHEMA_VERSION,
  reduceMissionEvents,
  type MissionEvent,
  type MissionJsonValue,
  type MissionLocation,
  type MissionReport,
  type MissionRevisedEvent,
  type MissionSnapshot,
  type MissionTemplateId,
} from "./model"
import { runMissionExclusive } from "./exclusive"
import { parseExecution } from "./execution"

const STORAGE_PREFIX = "codenomad-missions/v1"
const PAGE_SIZE = 100
const MAX_TEXT = 20_000
const MAX_SHORT_TEXT = 240

export interface MissionStorage {
  get(key: string): Promise<MissionJsonValue | undefined>
  set(key: string, value: MissionJsonValue): Promise<void>
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

  async events(): Promise<{ events: MissionEvent[]; discardedEvents: number }> {
    const events: MissionEvent[] = []
    let discardedEvents = 0
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix: this.prefix(), after, limit: PAGE_SIZE })
      for (const entry of page.entries) {
        if (events.length + discardedEvents >= MISSION_MAX_EVENTS) {
          throw new Error(`Mission journal exceeds the ${MISSION_MAX_EVENTS}-event safety limit`)
        }
        const event = parseMissionEvent(entry.value)
        if (!event || event.projectID !== this.projectID) discardedEvents += 1
        else events.push(event)
      }
      after = page.next
    } while (after)

    return { events, discardedEvents }
  }

  async snapshot(): Promise<MissionSnapshot> {
    const { events, discardedEvents } = await this.events()
    const snapshot = reduceMissionEvents(events, this.now())
    snapshot.projectID = this.projectID
    snapshot.discardedEvents += discardedEvents
    return snapshot
  }

  append(event: MissionEvent): Promise<void> {
    return runMissionExclusive(`append:${this.projectToken}`, () => this.appendUnlocked(event))
  }

  async event(missionID: string, eventID: string): Promise<MissionEvent | undefined> {
    const value = await this.storage.get(`${this.prefix()}/${safeKey(missionID)}/${safeKey(eventID)}`)
    const parsed = value === undefined ? undefined : parseMissionEvent(value)
    return parsed?.projectID === this.projectID ? parsed : undefined
  }

  async assertCanAppend(count = 1): Promise<void> {
    const capacity = await this.storedCapacity()
    if (capacity.count + capacity.cleanupSlots.size + count > MISSION_MAX_EVENTS) {
      throw new Error(`Mission journal reached the ${MISSION_MAX_EVENTS}-event safety limit`)
    }
  }

  private async appendUnlocked(event: MissionEvent): Promise<void> {
    if (event.projectID !== this.projectID) throw new Error("Mission event belongs to another project")
    const normalized = JSON.parse(JSON.stringify(event)) as unknown
    const parsed = parseMissionEvent(normalized)
    if (!parsed) throw new Error("Mission event is not durable JSON")
    const stored = JSON.parse(JSON.stringify(parsed)) as MissionJsonValue
    const key = `${this.prefix()}/${safeKey(event.missionID)}/${safeKey(event.id)}`
    const existing = await this.storage.get(key)
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(stored)) throw new Error("Mission event identity collision")
      return
    }
    const capacity = await this.storedCapacity()
    const consumesCleanupSlot = event.type === "mission.session-cleaned"
      && capacity.cleanupSlots.has(`${event.deletionID}\0${event.sessionID}`)
    const consumesControlSlot = event.type === "mission.control-applied"
      && capacity.cleanupSlots.has(`${event.operationID}\0${event.sessionID}`)
    const required = consumesCleanupSlot || consumesControlSlot ? 0 : 1
      + (event.type === "mission.deleted" ? event.cleanupTargets?.length ?? 0 : 0)
      + (event.type === "mission.control-requested" ? event.targets.length : 0)
    if (capacity.count + capacity.cleanupSlots.size + required > MISSION_MAX_EVENTS) {
      throw new Error(`Mission journal reached the ${MISSION_MAX_EVENTS}-event safety limit`)
    }
    await this.storage.set(key, stored)
  }

  private async storedCapacity(): Promise<{ count: number; cleanupSlots: Set<string> }> {
    let count = 0
    const cleanupSlots = new Set<string>()
    const receipts = new Set<string>()
    const latestControls = new Map<string, Extract<MissionEvent, { type: "mission.control-requested" }>>()
    let after: string | undefined
    do {
      const page = await this.storage.scan({ prefix: this.prefix(), after, limit: PAGE_SIZE })
      count += page.entries.length
      if (count > MISSION_MAX_EVENTS) throw new Error(`Mission journal exceeds the ${MISSION_MAX_EVENTS}-event safety limit`)
      for (const entry of page.entries) {
        const event = parseMissionEvent(entry.value)
        if (event?.type === "mission.deleted") {
          for (const target of event.cleanupTargets ?? []) cleanupSlots.add(`${event.id}\0${target.sessionID}`)
        } else if (event?.type === "mission.session-cleaned") receipts.add(`${event.deletionID}\0${event.sessionID}`)
        else if (event?.type === "mission.control-requested") {
          const previous = latestControls.get(event.missionID)
          if (!previous || event.createdAt > previous.createdAt || (event.createdAt === previous.createdAt && event.id > previous.id)) latestControls.set(event.missionID, event)
        } else if (event?.type === "mission.control-applied") receipts.add(`${event.operationID}\0${event.sessionID}`)
      }
      after = page.next
    } while (after)
    for (const operation of latestControls.values()) {
      for (const target of operation.targets) cleanupSlots.add(`${operation.id}\0${target.sessionID}`)
    }
    for (const receipt of receipts) cleanupSlots.delete(receipt)
    return { count, cleanupSlots }
  }

  private prefix(): string {
    return `${STORAGE_PREFIX}/${this.projectToken}`
  }
}

export function stableToken(value: string, length = 26): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length)
}

function safeKey(value: string): string {
  if (!/^[A-Za-z0-9_-]{3,100}$/.test(value)) throw new Error("Mission journal key is invalid")
  return value
}

export function parseMissionEvent(input: unknown): MissionEvent | undefined {
  if (!record(input) || input.version !== MISSION_SCHEMA_VERSION || !baseEvent(input)) return undefined
  switch (input.type) {
    case "mission.created": {
      if (!text(input.projectCanonical, MAX_TEXT) || !text(input.objective, MAX_TEXT)
        || !template(input.template) || !record(input.coordinator)) return undefined
      const location = parseLocation(input.coordinator.location)
      if (!location || !text(input.coordinator.sessionID, MAX_SHORT_TEXT)
        || !text(input.coordinator.title, MAX_SHORT_TEXT)) return undefined
      if (input.notes !== undefined && !boundedText(input.notes, MAX_TEXT)) return undefined
      if (input.prepared !== undefined && typeof input.prepared !== "boolean") return undefined
      return {
        ...eventBase(input),
        type: "mission.created",
        projectCanonical: input.projectCanonical,
        objective: input.objective,
        notes: input.notes as string | undefined,
        template: input.template,
        coordinator: {
          sessionID: input.coordinator.sessionID,
          title: input.coordinator.title,
          location,
        },
        ...(input.requestID === undefined ? {} : { requestID: input.requestID as string }),
        ...(input.prepared === undefined ? {} : { prepared: input.prepared as boolean }),
      }
    }
    case "mission.control-requested": {
      if (!text(input.requestID, 128) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1
        || !["start", "pause", "stop"].includes(String(input.action)) || !Array.isArray(input.targets) || input.targets.length > MISSION_MAX_ACTORS || !input.targets.length) return undefined
      const targets: Array<{ sessionID: string; location: MissionLocation }> = []
      for (const target of input.targets) {
        if (!record(target) || !text(target.sessionID, MAX_SHORT_TEXT)) return undefined
        const location = parseLocation(target.location)
        if (!location || targets.some(item => item.sessionID === target.sessionID)) return undefined
        targets.push({ sessionID: target.sessionID, location })
      }
      return { ...eventBase(input), type: "mission.control-requested", requestID: input.requestID, expectedRevision: Number(input.expectedRevision), action: input.action as "start" | "pause" | "stop", targets }
    }
    case "mission.control-applied":
      if (!text(input.operationID, MAX_SHORT_TEXT) || !text(input.sessionID, MAX_SHORT_TEXT)) return undefined
      return { ...eventBase(input), type: "mission.control-applied", operationID: input.operationID, sessionID: input.sessionID }
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
      return { ...eventBase(input), type: "mission.session-cleaned", deletionID: input.deletionID, sessionID: input.sessionID, outcome: input.outcome }
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
          || !text(added.title, MAX_SHORT_TEXT) || !text(added.brief, MAX_TEXT) || !text(added.role, MAX_SHORT_TEXT)
          || !text(added.replacesTaskKey, MAX_SHORT_TEXT) || !stringArray(added.blockedBy, 24, MAX_SHORT_TEXT)) return undefined
        let execution
        try { execution = parseExecution(added.execution) } catch { return undefined }
        addedTasks.push({
          id: added.id, key: added.key, title: added.title, brief: added.brief, role: added.role,
          ...(execution === undefined ? {} : { execution }), blockedBy: added.blockedBy, replacesTaskKey: added.replacesTaskKey,
        })
      }
      const dependencyUpdates: MissionRevisedEvent["dependencyUpdates"] = []
      for (const update of input.dependencyUpdates) {
        if (!record(update) || !text(update.taskKey, MAX_SHORT_TEXT) || !stringArray(update.blockedBy, 24, MAX_SHORT_TEXT)) return undefined
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
        || !text(input.task.title, MAX_SHORT_TEXT) || !text(input.task.brief, MAX_TEXT)
        || !text(input.task.role, MAX_SHORT_TEXT) || !stringArray(input.task.blockedBy, 24, MAX_SHORT_TEXT)) return undefined
      let execution
      try { execution = parseExecution(input.task.execution) } catch { return undefined }
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
          blockedBy: input.task.blockedBy,
        },
      }
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
      return text(input.reportID, MAX_SHORT_TEXT) && text(input.admissionID, MAX_SHORT_TEXT)
        ? { ...eventBase(input), type: "report.notified", reportID: input.reportID, admissionID: input.admissionID }
        : undefined
    case "mission.finished":
      return (input.outcome === "completed" || input.outcome === "failed") && text(input.summary, MAX_TEXT)
        ? { ...eventBase(input), type: "mission.finished", outcome: input.outcome, summary: input.summary }
        : undefined
    default:
      return undefined
  }
}

function parseReport(input: unknown): MissionReport | undefined {
  if (!record(input) || !text(input.id, MAX_SHORT_TEXT) || !text(input.taskKey, MAX_SHORT_TEXT)
    || !text(input.sessionId, MAX_SHORT_TEXT) || !text(input.summary, MAX_TEXT)
    || !["completed", "blocked", "failed"].includes(String(input.outcome))
    || !stringArray(input.evidence, 12, 2_000) || !stringArray(input.next, 12, 2_000)
    || !Number.isSafeInteger(input.createdAt) || Number(input.createdAt) <= 0
    || (input.artifact !== undefined && !isJsonValue(input.artifact))
    || (input.late !== undefined && typeof input.late !== "boolean")) return undefined
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
  return value === "custom" || value === "pocock-fix-bug" || value === "wayfinder"
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
