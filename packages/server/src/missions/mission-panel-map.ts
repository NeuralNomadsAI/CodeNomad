// Shared with the UI: keep it free of Node modules.
import type { MissionBriefing, MissionMap, MissionPlanChange, MissionReport, MissionTask } from "./model"
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

export type MissionPanelTask = Omit<MissionTask, "brief" | "executionMode" | "report" | "lateReports"> & {
  executionMode?: MissionPanelExecutionMode
  report?: MissionPanelReport
  lateReports?: MissionPanelReport[]
}

export type MissionPanelPlanChange = Omit<MissionPlanChange, "reason" | "objective" | "notes"> & {
  /** `missionExcerpt` of the reason. */
  excerpt?: string
}

/** A briefing's content: the map's `briefing` body, which compact maps drop and keep its identity. */
export const MISSION_BRIEFING_CONTENT = ["summary", "achieved", "ongoing", "obstacles", "next"] as const
/** A briefing's identity in a compact map, without its content. */
export type MissionPanelBriefing = Omit<MissionBriefing, typeof MISSION_BRIEFING_CONTENT[number]>

/** A map as the list and mission reads return it (`compactMissionMap`): no body field
 * (`MISSION_BODY_FIELDS`), each one's descriptor in its owner's `bodies`, and bounded
 * excerpts. A full map is one too, so a passage's own map shows through the same views. */
export type MissionPanelMap = Omit<MissionMap, "objective" | "notes" | "summary" | "briefing" | "tasks" | "reports" | "history"> & {
  /** The objective's display label (`missionObjectiveLabel`). */
  excerpt?: string
  briefing?: MissionPanelBriefing
  tasks: MissionPanelTask[]
  reports: MissionPanelReport[]
  history: MissionPanelPlanChange[]
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
