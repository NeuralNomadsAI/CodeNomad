import type { MissionListUnavailableResponse, MissionPanelMap } from "./model"

/** Which body a map shows, without its text: the length and digest of the text a
 * content read slices from it (`contentText`, `contentDigest`). The compact maps of the
 * list and mission reads carry one in place of each body field, in the owner's `bodies`. */
export interface MissionBodyDescriptor { characters: number; digest: string }
export type MissionBodyDescriptors = Partial<Record<string, MissionBodyDescriptor>>

/** The body fields that carry descriptors, per selector kind. */
export const MISSION_BODY_FIELDS = {
  mission: ["objective", "notes", "summary", "briefing"],
  task: ["brief", "executionMode", "report", "lateReports"],
  report: ["summary", "next", "evidence", "artifact"],
  change: ["reason", "objective", "notes"],
} as const

/** A mission body's place in the live map: a map field, a task's own field (and its
 * `reports`), any report by ID, or a plan change by revision. Fields are the map's own keys. */
export type MissionContentSelector =
  | { kind: "mission"; field: string }
  | { kind: "task"; taskKey: string; field: string }
  | { kind: "report"; reportId: string; field: string }
  | { kind: "change"; change: number; field: string }

/** A display read of one mission body (`MissionControl.content`), in slices. The first
 * read starts at offset 0 without a digest; its answer names the value's `digest`, which
 * every later slice repeats so it is cut from exactly that value. */
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

/** The descriptor `mission` gives the body at `selector`: a report's from the mission's
 * own `reports`, which hold every report and which the report selector reads. Undefined
 * when the map names none: no such body, or a full map (descriptors are on compact maps only). */
export function missionBodyDescriptor(mission: MissionPanelMap, selector: MissionContentSelector): MissionBodyDescriptor | undefined {
  if (selector.kind === "mission") return mission.bodies?.[selector.field]
  if (selector.kind === "task") return mission.tasks.find(task => task.key === selector.taskKey)?.bodies?.[selector.field]
  if (selector.kind === "report") return mission.reports.find(report => report.id === selector.reportId)?.bodies?.[selector.field]
  return mission.history.find(change => change.revision === selector.change)?.bodies?.[selector.field]
}
