import { createHash } from "node:crypto"

import {
  MISSION_MAX_EVENTS,
  MISSION_SCHEMA_VERSION,
  reduceMissionEvents,
  type MissionEvent,
  type MissionJsonValue,
  type MissionLocation,
  type MissionReport,
  type MissionSnapshot,
  type MissionTemplateId,
} from "./model"

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

  async snapshot(): Promise<MissionSnapshot> {
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

    const snapshot = reduceMissionEvents(events, this.now())
    snapshot.projectID = this.projectID
    snapshot.discardedEvents += discardedEvents
    return snapshot
  }

  async append(event: MissionEvent): Promise<void> {
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
    await this.storage.set(key, stored)
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
      if (input.notes !== undefined && !text(input.notes, MAX_TEXT)) return undefined
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
      }
    }
    case "task.created": {
      if (!record(input.task) || !text(input.task.id, MAX_SHORT_TEXT) || !text(input.task.key, MAX_SHORT_TEXT)
        || !text(input.task.title, MAX_SHORT_TEXT) || !text(input.task.brief, MAX_TEXT)
        || !text(input.task.role, MAX_SHORT_TEXT) || !stringArray(input.task.blockedBy, 24, MAX_SHORT_TEXT)) return undefined
      return {
        ...eventBase(input),
        type: "task.created",
        task: {
          id: input.task.id,
          key: input.task.key,
          title: input.task.title,
          brief: input.task.brief,
          role: input.task.role,
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
    || (input.artifact !== undefined && !isJsonValue(input.artifact))) return undefined
  return {
    id: input.id,
    taskKey: input.taskKey,
    sessionId: input.sessionId,
    outcome: input.outcome as MissionReport["outcome"],
    summary: input.summary,
    evidence: input.evidence,
    next: input.next,
    artifact: input.artifact,
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
  return { directory: input.directory, workspaceID: input.workspaceID as string | undefined }
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
