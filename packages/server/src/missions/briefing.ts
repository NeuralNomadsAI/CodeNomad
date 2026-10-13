import type { MissionMap } from "./model"

/** Coordinator narrative, not task settlement, native activity or human consent. */
export interface MissionBriefingItem { text: string; taskKeys: string[] }
export interface MissionBriefingContent {
  summary: string
  achieved: MissionBriefingItem[]
  ongoing: MissionBriefingItem[]
  obstacles: MissionBriefingItem[]
  next: MissionBriefingItem[]
}
export interface MissionBriefing extends MissionBriefingContent {
  id: string
  requestID: string
  basedOnRevision: number
  basedOnUpdatedAt: number
  createdAt: number
}
/** Identity of one accepted briefing: proof that the coordinator published a
 * response to this exact request, never that a person read it. */
export interface MissionBriefingResponse { requestID: string; briefingID: string }
/** Retained responses to explicit requests only. Unrequested `auto:<revision>`
 * briefings answer nobody, so any number of them never evicts a request. */
export const MISSION_BRIEFING_RESPONSES_MAX = 16

/** The protocol's unrequested milestone identity; nobody waits on it. */
export function isAutomaticBriefing(briefing: Pick<MissionBriefing, "requestID" | "basedOnRevision">): boolean {
  return briefing.requestID === `auto:${briefing.basedOnRevision}`
}
export interface MissionBriefingInput extends MissionBriefingContent {
  missionID?: string
  requestID: string
  basedOnRevision: number
}

const textSchema = { type: "string", minLength: 1, maxLength: 600 }
const itemsSchema = { type: "array", maxItems: 3, items: { type: "object", properties: {
  text: textSchema, taskKeys: { type: "array", maxItems: 8, items: { type: "string", maxLength: 64 } },
}, required: ["text", "taskKeys"], additionalProperties: false } }
export const missionBriefingSchema = { type: "object", properties: {
  missionID: { type: "string", maxLength: 100 }, requestID: { type: "string", minLength: 1, maxLength: 128 },
  basedOnRevision: { type: "integer", minimum: 1 }, summary: { type: "string", minLength: 1, maxLength: 1200 },
  achieved: itemsSchema, ongoing: itemsSchema, obstacles: itemsSchema, next: itemsSchema,
}, required: ["requestID", "basedOnRevision", "summary", "achieved", "ongoing", "obstacles", "next"], additionalProperties: false }

export const missionBriefingSnapshotSchema = { type: "object", properties: {
  id: { type: "string", minLength: 1, maxLength: 100 },
  requestID: missionBriefingSchema.properties.requestID,
  basedOnRevision: missionBriefingSchema.properties.basedOnRevision,
  basedOnUpdatedAt: { type: "integer", minimum: 0 }, createdAt: { type: "integer", minimum: 0 },
  summary: missionBriefingSchema.properties.summary,
  achieved: itemsSchema, ongoing: itemsSchema, obstacles: itemsSchema, next: itemsSchema,
}, required: ["id", "requestID", "basedOnRevision", "basedOnUpdatedAt", "createdAt", "summary", "achieved", "ongoing", "obstacles", "next"], additionalProperties: false }

export const missionBriefingResponsesSchema = { type: "array", maxItems: MISSION_BRIEFING_RESPONSES_MAX, items: {
  type: "object", properties: { requestID: missionBriefingSchema.properties.requestID, briefingID: missionBriefingSnapshotSchema.properties.id },
  required: ["requestID", "briefingID"], additionalProperties: false } }

export function parseMissionBriefingInput(input: unknown): MissionBriefingInput {
  const value = record(input)
  if (!Number.isSafeInteger(value.basedOnRevision) || Number(value.basedOnRevision) < 1) throw new Error("Invalid briefing revision")
  return {
    ...(value.missionID === undefined ? {} : { missionID: text(value.missionID, 100) }),
    requestID: text(value.requestID, 128), basedOnRevision: Number(value.basedOnRevision),
    summary: text(value.summary, 1200), achieved: items(value.achieved), ongoing: items(value.ongoing),
    obstacles: items(value.obstacles), next: items(value.next),
  }
}

export function parseMissionBriefing(input: unknown): MissionBriefing | undefined {
  try {
    const value = record(input), content = parseMissionBriefingInput(value)
    if (!Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0
      || !Number.isSafeInteger(value.basedOnUpdatedAt) || Number(value.basedOnUpdatedAt) < 0
      || Number(value.basedOnUpdatedAt) >= Number(value.createdAt)) return undefined
    return { summary: content.summary, achieved: content.achieved, ongoing: content.ongoing,
      obstacles: content.obstacles, next: content.next, requestID: content.requestID,
      basedOnRevision: content.basedOnRevision, id: text(value.id, 100),
      basedOnUpdatedAt: Number(value.basedOnUpdatedAt), createdAt: Number(value.createdAt) }
  } catch { return undefined }
}

export function briefingSourcesExist(mission: Pick<MissionMap, "tasks">, content: MissionBriefingContent): boolean {
  const keys = new Set(mission.tasks.filter(task => task.status !== "withdrawn" && !task.replacedByTaskKey).map(task => task.key))
  return [content.achieved, content.ongoing, content.obstacles, content.next].flat().every(item => item.taskKeys.every(key => keys.has(key)))
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid briefing object")
  return input as Record<string, unknown>
}
function text(input: unknown, max: number): string {
  if (typeof input !== "string" || !input.trim() || input.length > max) throw new Error("Invalid briefing text")
  return input
}
function items(input: unknown): MissionBriefingItem[] {
  if (!Array.isArray(input) || input.length > 3) throw new Error("Invalid briefing items")
  return input.map(item => {
    const value = record(item)
    if (!Array.isArray(value.taskKeys) || value.taskKeys.length > 8) throw new Error("Invalid briefing sources")
    const taskKeys = value.taskKeys.map(key => text(key, 64))
    if (new Set(taskKeys).size !== taskKeys.length) throw new Error("Duplicate briefing sources")
    return { text: text(value.text, 600), taskKeys }
  })
}
