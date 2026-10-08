import { z } from "zod"
import { recurrenceIDSchema } from "./recurrence-contract"
import type { MissionMap, MissionReport, MissionTask } from "./model"

export const recurrenceCurrentInput = z.object({ scheduleID: recurrenceIDSchema }).strict()
const labels = ["summary", "objective", "notes", "evidence", "next", "brief", "artifact", "achieved", "ongoing", "obstacles"] as const
export const recurrenceCurrentContentInput = recurrenceCurrentInput.extend({ passageID: recurrenceIDSchema,
  kind: z.enum(["overview", "task", "report", "change"]), itemId: z.string().min(1).max(240).optional(),
  section: z.enum(labels).default("summary"), page: z.number().int().min(0).max(63).default(0),
  revision: z.number().int().positive().safe().optional(),
}).strict().refine(input => input.kind === "overview" ? input.itemId === undefined : input.itemId !== undefined,
  "Reader target identity differs")
export type RecurrenceCurrentContentInput = z.infer<typeof recurrenceCurrentContentInput>
export const recurrenceCurrentContentPage = z.object({ version: z.literal(1), projectID: z.string().min(1).max(240),
  scheduleID: recurrenceIDSchema, passageID: recurrenceIDSchema, missionID: z.string().min(1).max(240),
  revision: z.number().int().positive().safe(),
  page: z.number().int().min(0).max(63), pageCount: z.number().int().min(1).max(64), sourceText: z.string().max(9_001), markdownText: z.null(),
}).strict()
const id = { type: "string", minLength: 3, maxLength: 100 } as const
const counter = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const
const contentProperties = { scheduleID: id, passageID: id, section: { type: "string", enum: labels },
  page: { ...counter, maximum: 63 }, revision: { ...counter, minimum: 1 } } as const
export const recurrenceCurrentContentWire = {
  input: { type: "object", oneOf: [
    { type: "object", properties: { ...contentProperties, kind: { type: "string", const: "overview" } },
      required: ["scheduleID", "passageID", "kind"], additionalProperties: false },
    { type: "object", properties: { ...contentProperties, kind: { type: "string", enum: ["task", "report", "change"] },
      itemId: { type: "string", minLength: 1, maxLength: 240 } },
      required: ["scheduleID", "passageID", "kind", "itemId"], additionalProperties: false },
  ] },
  output: { type: "object", properties: { version: { type: "integer", const: 1 }, projectID: { type: "string" },
    projectCanonical: { type: "string" }, location: { type: "object", properties: { directory: { type: "string" }, workspaceID: { type: "string" } }, required: ["directory"], additionalProperties: false },
    scheduleID: id, passageID: id, missionID: { type: "string" }, revision: { ...counter, minimum: 1 },
    page: { ...counter, maximum: 63 }, pageCount: { ...counter, minimum: 1, maximum: 64 }, sourceText: { type: "string", maxLength: 9_001 }, markdownText: { type: "null" },
  }, required: ["version", "projectID", "projectCanonical", "location", "scheduleID", "passageID", "missionID", "revision", "page", "pageCount", "sourceText", "markdownText"], additionalProperties: false },
} as const

function currentReport(task: MissionTask): MissionReport | undefined {
  const report = task.report
  if (!report || report.late || report.taskKey !== task.key || task.replacedByTaskKey
    || task.status !== (report.outcome === "blocked" ? "needs-input" : report.outcome)
    || report.nativeCall && report.nativeCall.generation !== task.contractGeneration) return undefined
  return report
}

/** Page only stored business content. No transcript/session selector or text rewrite. */
export function currentRecurrenceContent(mission: MissionMap, raw: unknown) {
  const input = recurrenceCurrentContentInput.parse(raw)
  if (input.revision !== undefined && input.revision !== mission.revision) throw new Error("Current passage revision changed")
  const sections: Partial<Record<typeof labels[number], string>> = {}
  const reportSections = (report: MissionReport | undefined) => {
    if (!report) return
    sections.summary = report.summary; sections.evidence = report.evidence.join("\n\n"); sections.next = report.next.join("\n\n")
    if (report.artifact !== undefined) sections.artifact = JSON.stringify(report.artifact, null, 2)
  }
  if (input.kind === "overview") {
    sections.summary = mission.summary ?? mission.briefing?.summary ?? ""
    sections.objective = mission.objective; sections.notes = mission.notes ?? ""
    if (mission.briefing && !mission.summary) {
      for (const label of ["achieved", "ongoing", "obstacles", "next"] as const) sections[label] = mission.briefing[label].map(item => item.text).join("\n\n")
    } else if (!mission.summary) {
      const tasks = mission.tasks.filter(task => task.status !== "withdrawn" && !task.replacedByTaskKey)
      const recorded = tasks.filter(task => currentReport(task)?.outcome === "completed").sort((a, b) => b.report!.createdAt - a.report!.createdAt).slice(0, 3)
      const obstacles = mission.status === "active" ? tasks.filter(task => ["needs-input", "failed"].includes(task.status) && currentReport(task)).slice(0, 3) : []
      sections.achieved = recorded.map(task => `${task.title}\n\n${task.report!.summary}`).join("\n\n")
      sections.obstacles = obstacles.map(task => `${task.title}\n\n${task.report!.summary}`).join("\n\n")
    }
  } else if (input.kind === "task") {
    const task = mission.tasks.find(task => task.id === input.itemId)
    if (!task) throw new Error("Current passage task unavailable")
    sections.brief = task.brief
    sections.notes = task.executionMode?.kind === "independent" ? task.executionMode.explanation : ""
    reportSections(currentReport(task))
  } else if (input.kind === "report") {
    const reports = new Map([...mission.reports, ...mission.tasks.flatMap(task => task.lateReports ?? []),
      ...mission.tasks.flatMap(task => task.report ? [task.report] : [])].map(report => [report.id, report]))
    const report = reports.get(input.itemId!)
    if (!report) throw new Error("Current passage report unavailable")
    reportSections(report)
  } else {
    const change = mission.history.find(change => String(change.revision) === input.itemId)
    if (!change) throw new Error("Current passage change unavailable")
    sections.summary = change.reason ?? ""
    // Preserve the native before/after fields, without inventing localized prose.
    if (change.objective) sections.objective = JSON.stringify(change.objective, null, 2)
    if (change.notes) sections.notes = JSON.stringify(change.notes, null, 2)
  }
  const text = sections[input.section]
  if (text === undefined) throw new Error("Current passage section unavailable")
  if (text.length > 576_000) throw new Error("Current passage content capacity")
  const pageCount = Math.max(1, Math.ceil(text.length / 9_000))
  if (input.page >= pageCount) throw new Error("Current passage page unavailable")
  const boundary = (offset: number) => {
    const end = Math.min(offset, text.length), next = text.charCodeAt(end), previous = text.charCodeAt(end - 1)
    return next >= 0xDC00 && next <= 0xDFFF && previous >= 0xD800 && previous <= 0xDBFF ? end - 1 : end
  }
  return recurrenceCurrentContentPage.parse({ version: 1 as const, projectID: mission.projectID, scheduleID: input.scheduleID, passageID: input.passageID,
    missionID: mission.id, revision: mission.revision, page: input.page, pageCount,
    sourceText: text.slice(boundary(input.page * 9_000), boundary((input.page + 1) * 9_000)), markdownText: null })
}
