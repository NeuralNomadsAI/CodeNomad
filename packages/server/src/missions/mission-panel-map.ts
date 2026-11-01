// Shared with the UI: keep it free of Node modules.
import type { MissionBriefing, MissionListUnavailableResponse, MissionMap, MissionPlanChange, MissionReport, MissionTask } from "./model"
import type { MissionTaskExecutionMode } from "./task-execution-mode"

/** Code points a report, plan-change or execution-mode excerpt keeps (`missionExcerpt`). */
export const MISSION_EXCERPT_MAX = 240

/** One line of `text` for a label: whitespace runs as one space, trimmed, at most `max`
 * code points, a cut ending in "…". Reads only as far as the excerpt needs. */
export function missionExcerpt(text: string, max = MISSION_EXCERPT_MAX): string {
  const points: string[] = []
  let gap = false
  for (const point of text) {
    if (/\s/.test(point)) { gap = points.length > 0; continue }
    if (gap) { points.push(" "); gap = false }
    points.push(point)
    if (points.length > max) return `${points.slice(0, max).join("").trimEnd()}…`
  }
  return points.join("")
}

/** A report in a compact map: its identity, outcome and delivery, without the prose
 * (`MISSION_BODY_FIELDS.report`) the content route reads. */
export type MissionPanelReport = Omit<MissionReport, "summary" | "next" | "evidence" | "artifact"> & {
  /** `missionExcerpt` of the summary. */
  excerpt?: string
  /** Who settled a Wayfinder decision (`missionDecisionMaker`), read from the artifact. */
  decidedBy?: "human" | "coordinator"
}

type IndependentMode = Extract<MissionTaskExecutionMode, { kind: "independent" }>
/** An execution mode in a compact map: an independent one without its explanation. */
export type MissionPanelExecutionMode = Exclude<MissionTaskExecutionMode, IndependentMode>
  | (Omit<IndependentMode, "explanation"> & { /** `missionExcerpt` of the explanation. */ excerpt?: string })

/** Task rows a compact map holds in its window of the display order, and a task page at most. */
export const MISSION_TASK_PAGE = 50
/** Rows a compact map adds beyond its window for what the panel must show of any task
 * (`compactMissionMap`): pending notifications, blockages and failures, recovery
 * candidates, the newest reports' tasks and the briefing's sources. Tasks needing action
 * beyond them are counted (`MissionTaskPage.attention`) and read by attention window. */
export const MISSION_TASK_PINS = 20
/** The newest late reports a compact task row keeps; the content route reads them all. */
export const MISSION_LATE_REPORT_ROWS = 1
/** Reports of a task row a compact map or page holds: its current one, its newest late one,
 * then its newest; the content route reads all of a task's (`reports`). */
export const MISSION_TASK_REPORT_ROWS = 3
/** The newest reports whose tasks a compact map pins, and the newest taskless reports it holds. */
export const MISSION_PINNED_REPORTS = 8

/** Which tasks a compact map or a task page holds, and what the whole map has. */
export interface MissionTaskPage {
  /** Digest of the display order (`missionTaskOrder`): a continuation names it. */
  order: string
  /** The window `[offset, end)` of the display order held, besides any pinned rows. */
  offset: number
  end: number
  /** The map's tasks, by status too, and reports. */
  total: number
  counts: Partial<Record<MissionTask["status"], number>>
  reports: number
  /** Pin candidates beyond `MISSION_TASK_PINS`, in a map. */
  pinsOmitted?: number
  /** The tasks needing action over the whole map, and those a map holds neither in its
   * window nor among its pins; an attention read pages through the latter. */
  attention?: MissionTaskAttention
}

/** Tasks needing action (`compactMissionMap`'s pin priority): pending notifications,
 * blockages, failures and reports to recover (a returned or admitted actor without one). */
export interface MissionTaskAttention {
  /** Over the whole map, by kind; a task can be of several. */
  counts: { notifications: number; blocked: number; failed: number; recovery: number }
  /** Those a map holds neither in its window nor among its pins, in pin priority. */
  omitted: number
  /** Digest of their keys in that priority: attention windows read under another sequence
   * cover nothing of this one, whatever the display order. */
  sequence: string
  /** In a map, the first `MISSION_TASK_PAGE` of those, read by key; an attention read
   * reaches the rest. */
  keys?: string[]
  /** An attention read's window `[offset, end)` of the omitted ones. */
  offset?: number
  end?: number
}

export type MissionPanelTask = Omit<MissionTask, "brief" | "executionMode" | "report" | "lateReports" | "nativeExecution"> & {
  executionMode?: MissionPanelExecutionMode
  report?: MissionPanelReport
  /** The newest `MISSION_LATE_REPORT_ROWS` late reports, in a compact row. */
  lateReports?: MissionPanelReport[]
  /** Every late report, beside a compact row's newest ones. */
  lateReportCount?: number
  /** The current invocation; a compact row holds none of its observations. */
  nativeExecution?: Omit<NonNullable<MissionTask["nativeExecution"]>, "observations">
  /** The task's position in the display order of the whole map, in a compact row. */
  order?: number
  /** Tasks that depend on this one, over the whole map, in a compact row. */
  dependents?: number
  /** The task's reports in the map, beside the `MISSION_TASK_REPORT_ROWS` a compact row's reports hold. */
  reportCount?: number
}

/** Plan-change fields a compact row holds no value of, beside the prose: lists the
 * content route reads whole (`MISSION_BODY_FIELDS.change`). */
export type MissionPanelPlanChange = Omit<MissionPlanChange, "reason" | "objective" | "notes" | "addedTaskKeys" | "retiredTasks" | "dependencyUpdates"> & {
  /** `missionExcerpt` of the reason. */
  excerpt?: string
}

/** Actors whose work a compact map says is owed, from all its tasks: the activity
 * projection's evidence when the map holds a page of them. */
export interface MissionActorEvidence { reportOwed: string[]; callOpen: string[] }

/** A read of more of a map's tasks (`MissionControl.tasks`), in the order `order` names:
 * the window of the display order at `offset`, the window of the tasks needing action that
 * a map omits at `attention` (`MissionTaskAttention`), or tasks by key, ID or report, at
 * most `MISSION_TASK_PAGE` names in all. */
export interface MissionTaskRequest { order?: string; offset?: number; attention?: number; keys?: string[]; ids?: string[]; reportIds?: string[] }
/** `order-changed`: the map's display order is no longer the one the request names. */
export type MissionTaskRefusal = "mission-not-found" | "order-changed"
export type MissionTaskPageResult = { version: 1; projectID: string; missionID: string; revision?: number }
  & ({ taskPage: MissionTaskPage; tasks: MissionPanelTask[]; reports: MissionPanelReport[] } | { refused: MissionTaskRefusal })
/** `GET /api/workspaces/:id/missions/:missionID/tasks`. */
export type MissionTaskPageResponse = ({ available: true } & MissionTaskPageResult) | MissionListUnavailableResponse

/** A briefing's content: the map's `briefing` body, which compact maps drop and keep its identity. */
export const MISSION_BRIEFING_CONTENT = ["summary", "achieved", "ongoing", "obstacles", "next"] as const
/** A briefing's identity in a compact map, without its content. */
export type MissionPanelBriefing = Omit<MissionBriefing, typeof MISSION_BRIEFING_CONTENT[number]>

/** A map as the list and mission reads return it (`compactMissionMap`): no body field
 * (`MISSION_BODY_FIELDS`), each one's descriptor in its owner's `bodies`, and bounded
 * excerpts. A full map is one too, so a passage's own map shows through the same views. */
export type MissionPanelMap = Omit<MissionMap, "objective" | "notes" | "summary" | "briefing" | "tasks" | "reports" | "history" | "frontier" | "claims"> & {
  /** The objective's display label (`missionObjectiveLabel`). */
  excerpt?: string
  briefing?: MissionPanelBriefing
  /** A compact map's rows: its window of the display order and pinned rows, in that order. */
  tasks: MissionPanelTask[]
  /** A compact map's: its rows' reports (`MISSION_TASK_REPORT_ROWS` each), and the newest taskless ones. */
  reports: MissionPanelReport[]
  history: MissionPanelPlanChange[]
  /** A compact map's page of tasks; absent from a full map, which holds them all. */
  taskPage?: MissionTaskPage
  actorEvidence?: MissionActorEvidence
}

/** A map that carries its bodies: a passage's own map, never a list or mission read's. */
export function isFullMissionMap(map: MissionPanelMap): map is MissionMap {
  return typeof (map as Partial<MissionMap>).objective === "string"
}

/** A report that carries its prose: a passage's own, never a compact map's row. */
export function isFullMissionReport(report: MissionPanelReport): report is MissionReport {
  return typeof (report as Partial<MissionReport>).summary === "string"
}

export function missionReportExcerpt(report: MissionPanelReport): string {
  return isFullMissionReport(report) ? missionExcerpt(report.summary) : report.excerpt ?? ""
}

/** Undefined for a change without a reason. */
export function missionChangeExcerpt(change: MissionPanelPlanChange): string | undefined {
  const reason = (change as Partial<MissionPlanChange>).reason
  return typeof reason === "string" ? missionExcerpt(reason) : change.excerpt
}

export function missionModeExcerpt(mode: MissionPanelExecutionMode | undefined): string {
  if (mode?.kind !== "independent") return ""
  const explanation = (mode as Partial<IndependentMode>).explanation
  return typeof explanation === "string" ? missionExcerpt(explanation) : mode.excerpt ?? ""
}
