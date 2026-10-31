import { z } from "zod"
import type { MissionListUnavailableResponse, MissionMap, MissionPlanChange } from "./model"
import { contentDigest, contentText, missionContentValue, sliceEnd, type MissionInspectSelector } from "./inspect-view"

/** A display read of one mission body (`MissionControl.content`): the value a selector
 * names in the mission's live map (a map field, a task's own field, any report by ID,
 * current, earlier or late, a plan change by revision), in slices. The first read
 * starts at offset 0 without a digest; its answer names the value's `digest`, which
 * every later slice repeats so it is cut from exactly that value. */
export type MissionContentSelector = Exclude<MissionInspectSelector, { kind: "inspection" }>
export type MissionContentRequest = MissionContentSelector & { missionID: string; digest?: string; offset: number }

/** Why a read returns no slice: no live map, no value at the selector, or a value that
 * now reads differently than the digest the read repeats. */
export type MissionContentRefusal = "mission-not-found" | "content-not-found" | "content-changed"

export interface MissionContentSlice {
  kind: MissionContentSelector["kind"]
  field: string
  taskKey?: string
  reportId?: string
  change?: number
  digest: string
  offset: number
  /** The whole value's text length; `text` is `[offset, next ?? characters)`. */
  characters: number
  /** The text is the value's JSON; otherwise it is the string itself. */
  json?: true
  text: string
  /** The offset of the next slice, present until the last. */
  next?: number
}

export type MissionContentResult = { version: 1; projectID: string; missionID: string; revision?: number }
  & ({ content: MissionContentSlice } | { refused: MissionContentRefusal })
/** `GET /api/workspaces/:id/missions/:missionID/content`. */
export type MissionContentResponse = ({ available: true } & MissionContentResult) | MissionListUnavailableResponse

const DIGEST = /^[A-Za-z0-9_-]{43}$/
const TASK_KEY = /^[a-z0-9][a-z0-9._-]{1,63}$/

/** Validates a content request: each kind names exactly its own identity, and a slice
 * past offset 0 repeats the digest of the value it continues. */
export const missionContentRequestSchema = z.object({
  missionID: z.string().trim().min(1).max(100),
  kind: z.enum(["mission", "task", "report", "change"]),
  field: z.string().min(1).max(64),
  taskKey: z.string().regex(TASK_KEY).optional(),
  reportId: z.string().min(1).max(240).optional(),
  change: z.number().int().positive().safe().optional(),
  digest: z.string().regex(DIGEST).optional(),
  offset: z.number().int().nonnegative().safe(),
}).strict().superRefine((value, context) => {
  const identity = { task: "taskKey", report: "reportId", change: "change" } as const
  for (const key of ["taskKey", "reportId", "change"] as const) {
    const wanted = value.kind !== "mission" && identity[value.kind] === key
    if (wanted !== (value[key] !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: wanted ? "Required" : "Not with this kind" })
  }
  if (value.offset > 0 && value.digest === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "A later slice repeats its digest" })
}).transform(value => value as MissionContentRequest)

/** The slice `request` names in `mission` (absent when its range holds no live map).
 * A plan change resolves among every change the same observation's events record
 * (`changes`), beyond the map's last ones. The whole answer, as two-space JSON, stays
 * within `MISSION_INSPECT_OUTPUT_LIMIT`. */
export function readMissionContent(projectID: string, request: MissionContentRequest, mission: MissionMap | undefined,
  changes: () => readonly MissionPlanChange[] = () => mission?.history ?? []): MissionContentResult {
  const base = { version: 1 as const, projectID, missionID: request.missionID }
  if (!mission || mission.id !== request.missionID) return { ...base, refused: "mission-not-found" }
  const { missionID: _missionID, digest: expected, offset, ...selector } = request
  let value: unknown
  try { value = missionContentValue(mission, selector, selector.kind === "change" ? changes() : mission.history) }
  catch { return { ...base, revision: mission.revision, refused: "content-not-found" } }
  const text = contentText(value), digest = contentDigest(text)
  if ((expected === undefined ? offset !== 0 : expected !== digest) || offset > text.length) {
    return { ...base, revision: mission.revision, refused: "content-changed" }
  }
  const answer = (end: number): MissionContentResult => ({ ...base, revision: mission.revision, content: {
    ...selector, digest, offset, characters: text.length, ...(typeof value === "string" ? {} : { json: true as const }),
    text: text.slice(offset, end), ...(end < text.length ? { next: end } : {}),
  } })
  return answer(sliceEnd(text, offset, answer))
}
