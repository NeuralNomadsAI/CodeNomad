import { z } from "zod"
import type { MissionMap, MissionPlanChange } from "./model"
import { contentDigest, contentText, missionContentValue, sliceEnd } from "./inspect-view"
import type { MissionContentRequest, MissionContentResult } from "./mission-content-wire"

// The wire types live apart, so the UI imports them without this module's node dependencies.
export type { MissionContentRefusal, MissionContentRequest, MissionContentResponse, MissionContentResult, MissionContentSelector,
  MissionContentSlice } from "./mission-content-wire"

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
