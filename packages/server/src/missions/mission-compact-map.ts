import { z } from "zod"
import { missionDecisionMaker } from "./decision-artifact"
import { missionTaskExecutionEvidence } from "./execution-evidence"
import { contentDigest } from "./inspect-view"
import { missionIsRunning } from "./lifecycle-model"
import { describe } from "./mission-body-descriptors"
import { MISSION_BODY_FIELDS, type MissionBodyDescriptors } from "./mission-content-wire"
import { MISSION_BRIEFING_CONTENT, MISSION_LATE_REPORT_ROWS, MISSION_TASK_PAGE, MISSION_TASK_PINS, MISSION_TASK_REPORT_ROWS, MISSION_PINNED_REPORTS, isFullMissionMap, isFullMissionReport,
  missionExcerpt, type MissionActorEvidence, type MissionPanelExecutionMode, type MissionPanelMap, type MissionPanelPlanChange, type MissionPanelReport,
  type MissionPanelTask, type MissionTaskAttention, type MissionTaskPage, type MissionTaskRequest } from "./mission-panel-map"
import { missionObjectiveLabel } from "./mission-summary"
import { missionTaskOrder } from "./mission-task-order"
import type { MissionMap, MissionPlanChange, MissionReport, MissionTask, MissionTaskExecutionMode } from "./model"
import { isCoordinatorNotificationReport } from "./native-report-provenance"

type AnyMap = MissionMap | MissionPanelMap
type AnyTask = MissionTask | MissionPanelTask
type AnyReport = MissionReport | MissionPanelReport

/** A copy of `owner` without `fields`; every other field, unknown ones included, stays. */
function without<T extends object, K extends keyof T>(owner: T, fields: readonly K[]): Omit<T, K> {
  const copy: Partial<T> = { ...owner }
  for (const field of fields) delete copy[field]
  return copy as Omit<T, K>
}

/** `owner`'s descriptors of `fields`: those it carries, and one for each field it holds without one. */
function described(owner: object, fields: readonly string[]): MissionBodyDescriptors {
  const own = (owner as { bodies?: MissionBodyDescriptors }).bodies ?? {}
  return { ...describe(owner, fields.filter(field => own[field] === undefined)), ...own }
}

/** A task request: a window of the display order, a window of the omitted tasks needing
 * action, or tasks by key, ID or report, at most `MISSION_TASK_PAGE` names in all, so that
 * a named read answers every task it names. */
export const missionTaskRequestSchema = z.object({
  missionID: z.string().trim().min(1).max(100),
  order: z.string().min(1).max(64).optional(),
  offset: z.number().int().nonnegative().safe().optional(),
  attention: z.number().int().nonnegative().safe().optional(),
  keys: z.array(z.string().min(1).max(64)).max(MISSION_TASK_PAGE).optional(),
  ids: z.array(z.string().min(1).max(240)).max(MISSION_TASK_PAGE).optional(),
  reportIds: z.array(z.string().min(1).max(240)).max(MISSION_TASK_PAGE).optional(),
}).strict().superRefine((value, context) => {
  const named = value.keys !== undefined || value.ids !== undefined || value.reportIds !== undefined
  if ([value.offset !== undefined, value.attention !== undefined, named].filter(Boolean).length !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A window, an attention window or tasks by key, ID or report" })
  }
  if ((value.keys?.length ?? 0) + (value.ids?.length ?? 0) + (value.reportIds?.length ?? 0) > MISSION_TASK_PAGE) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `At most ${MISSION_TASK_PAGE} names in all` })
  }
})

/** The whole map's plan: tasks in display order, their positions and dependents, and its totals. */
function plan(map: AnyMap) {
  const ordered = missionTaskOrder<AnyTask>(map.tasks)
  const position = new Map(ordered.map((task, index) => [task.key, index]))
  const dependents = new Map<string, number>(), counts: MissionTaskPage["counts"] = {}
  for (const task of ordered) {
    counts[task.status] = (counts[task.status] ?? 0) + 1
    for (const key of new Set(task.blockedBy)) if (position.has(key)) dependents.set(key, (dependents.get(key) ?? 0) + 1)
  }
  const page = { order: contentDigest(JSON.stringify(ordered.map(task => task.key))), total: ordered.length, counts, reports: map.reports.length }
  return { ordered, position, dependents, page }
}
type Plan = ReturnType<typeof plan>

/** A report row: without its bodies, beside their descriptors when `bodies` (the map's
 * `reports`), with a summary excerpt and who settled a decision. */
function reportRow(map: AnyMap, tasks: ReadonlyMap<string, AnyTask>, value: AnyReport, bodies: boolean): MissionPanelReport {
  if (!isFullMissionReport(value)) return bodies ? value : without(value, ["bodies"])
  const decidedBy = missionDecisionMaker(map.template, tasks.get(value.taskKey), value)
  return { ...without(value, MISSION_BODY_FIELDS.report), excerpt: missionExcerpt(value.summary), ...(decidedBy ? { decidedBy } : {}),
    ...(bodies ? { bodies: described(value, MISSION_BODY_FIELDS.report) } : {}) }
}

/** Compact rows of `selected` tasks in display order, and the reports of each from the
 * mission's own reports (with descriptors): its current one, those whose notification is
 * pending, its newest late one, then its newest, `MISSION_TASK_REPORT_ROWS` in all; and
 * the `named` reports besides. */
function rows(map: AnyMap, { position, dependents }: Plan, selected: readonly AnyTask[], named: ReadonlySet<string> = new Set()): { tasks: MissionPanelTask[]; reports: MissionPanelReport[] } {
  const tasks = new Map(map.tasks.map(task => [task.key, task as AnyTask]))
  const reportsOf = new Map<string, AnyReport[]>()
  for (const value of map.reports) {
    const list = reportsOf.get(value.taskKey)
    if (list) list.push(value)
    else reportsOf.set(value.taskKey, [value])
  }
  const mode = (value: MissionTaskExecutionMode | MissionPanelExecutionMode): MissionPanelExecutionMode => value.kind === "independent" && "explanation" in value
    ? { ...without(value, ["explanation"]), excerpt: missionExcerpt(value.explanation) } : value
  const ids = new Set<string>(named)
  const taskRows = [...new Set(selected)].sort((left, right) => position.get(left.key)! - position.get(right.key)!).map((task): MissionPanelTask => {
    const late = task.lateReports?.slice(-MISSION_LATE_REPORT_ROWS)
    const own = reportsOf.get(task.key) ?? [], newest = [...own].sort((left, right) => right.createdAt - left.createdAt)
    // A pending notification is shown wherever its task is: the newest follow the current report.
    const held = new Set([...task.report ? [task.report.id] : [], ...newest.filter(value => value.notificationStatus === "pending").map(value => value.id),
      ...late?.map(value => value.id) ?? []].slice(0, MISSION_TASK_REPORT_ROWS))
    for (const value of newest) {
      if (held.size >= MISSION_TASK_REPORT_ROWS) break
      held.add(value.id)
    }
    for (const id of held) ids.add(id)
    const native = task.nativeExecution && without(task.nativeExecution as NonNullable<MissionTask["nativeExecution"]>, ["observations"])
    // The task's every report, its content field `reports` (`missionContentValue`, from a
    // reduced map, which holds no descriptor): described when the map holds them whole, so a
    // reader of that history reads it again once it changes.
    const history = own.every(isFullMissionReport) ? describe({ reports: own.map(value => without(value as MissionReport & { bodies?: unknown }, ["bodies"])) }, ["reports"]) : {}
    return { ...without(task as MissionTask, MISSION_BODY_FIELDS.task), bodies: { ...history, ...described(task, MISSION_BODY_FIELDS.task) },
      ...(task.executionMode ? { executionMode: mode(task.executionMode) } : {}),
      ...(task.report ? { report: reportRow(map, tasks, task.report, false) } : {}),
      ...(late ? { lateReports: late.map(value => reportRow(map, tasks, value, false)), lateReportCount: (task as MissionPanelTask).lateReportCount ?? task.lateReports!.length } : {}),
      ...(native ? { nativeExecution: native } : {}),
      order: position.get(task.key)!, dependents: dependents.get(task.key) ?? 0, reportCount: own.length } as MissionPanelTask
  })
  return { tasks: taskRows, reports: map.reports.filter(value => ids.has(value.id)).map(value => reportRow(map, tasks, value, true)) }
}

/** The map's tasks needing action, in pin priority: those with a pending notification,
 * blockages and failures (newest first), then reports to recover; with counts by kind. */
function attention(map: AnyMap, { ordered }: Plan) {
  const known = new Set(ordered.map(task => task.key)), keys = new Set<string>()
  const counts: MissionTaskAttention["counts"] = { notifications: 0, blocked: 0, failed: 0, recovery: 0 }
  const notified = new Set(map.reports.filter(value => value.notificationStatus === "pending" && known.has(value.taskKey)).map(value => value.taskKey))
  counts.notifications = notified.size
  for (const key of notified) keys.add(key)
  for (const task of ordered.filter(task => task.status === "needs-input" || task.status === "failed").sort((left, right) => right.updatedAt - left.updatedAt)) {
    counts[task.status === "failed" ? "failed" : "blocked"]++
    keys.add(task.key)
  }
  for (const task of ordered) if (task.actorSessionId && missionTaskExecutionEvidence(task).missingReport) { counts.recovery++; keys.add(task.key) }
  return { keys: [...keys], counts }
}

/** The window (the first `MISSION_TASK_PAGE` of the display order) and what the panel must
 * show of any task beyond it, at most `MISSION_TASK_PINS`: the tasks needing action
 * (`attention`), then the newest reports' tasks and the briefing's sources. The tasks
 * needing action left out are counted and listed for attention reads. */
function shown(map: AnyMap, whole: Plan) {
  const window = whole.ordered.slice(0, MISSION_TASK_PAGE), inWindow = new Set(window.map(task => task.key))
  const byKey = new Map(whole.ordered.map(task => [task.key, task]))
  const urgent = attention(map, whole), candidates = new Set<string>()
  const add = (key: string) => { if (byKey.has(key) && !inWindow.has(key)) candidates.add(key) }
  for (const key of urgent.keys) add(key)
  for (const value of [...map.reports].sort((left, right) => right.createdAt - left.createdAt).slice(0, MISSION_PINNED_REPORTS)) add(value.taskKey)
  if (isFullMissionMap(map) && map.briefing) for (const section of ["achieved", "ongoing", "obstacles", "next"] as const) {
    for (const item of map.briefing[section]) for (const key of item.taskKeys) add(key)
  }
  const keys = [...candidates], pinnedKeys = new Set(keys.slice(0, MISSION_TASK_PINS))
  const omittedAttention = urgent.keys.filter(key => !inWindow.has(key) && !pinnedKeys.has(key)).map(key => byKey.get(key)!)
  return { window, pinned: [...pinnedKeys].map(key => byKey.get(key)!), pinsOmitted: Math.max(0, keys.length - MISSION_TASK_PINS),
    omittedAttention, attention: { counts: urgent.counts, omitted: omittedAttention.length,
      sequence: contentDigest(JSON.stringify(omittedAttention.map(task => task.key))) } as MissionTaskAttention }
}

/** The actors whose work all of the map's tasks say is owed: what the activity projection
 * reads from tasks, so that a page of them projects the same activity. */
function evidence(map: AnyMap, tasks: readonly AnyTask[]): MissionActorEvidence {
  const reportOwed = new Set<string>(), callOpen = new Set<string>()
  // A running mission's coordinator owes its final report, unless a report's coordinator notification is pending.
  if (missionIsRunning(map) && !map.reports.some(value => value.notificationStatus === "pending" && isCoordinatorNotificationReport(value))) reportOwed.add(map.coordinatorSessionId)
  for (const task of tasks) {
    if (!task.actorSessionId) continue
    const observed = missionTaskExecutionEvidence(task)
    if (observed.missingReport) reportOwed.add(task.actorSessionId)
    if (observed.nativeCall === "active" || observed.nativeCall === "unknown") callOpen.add(task.actorSessionId)
  }
  return { reportOwed: [...reportOwed], callOpen: [...callOpen] }
}

/** `map` as the list and mission reads return it: each body field (`MISSION_BODY_FIELDS`)
 * dropped beside its descriptor, with in their place what the panel shows without
 * reading them: the objective's label, report rows with a summary excerpt and who
 * settled a decision, the briefing's identity, an independent mode's reason with an
 * explanation excerpt, and plan changes with a reason excerpt. Its tasks are a page: the
 * first `MISSION_TASK_PAGE` of the display order and pinned rows (`shown`), each with its
 * position, dependents and report count, a descriptor of its whole history, its newest
 * late reports and its invocation without observations; `taskPage` names the order, the
 * map's totals and its tasks needing action (`attention`), `actorEvidence` the owed work
 * of all its tasks, and the reports are its rows' (`rows`) and the newest taskless ones.
 * A copy: the map passed is unchanged, and a compact page is returned as it is. */
export function compactMissionMap(map: AnyMap): MissionPanelMap {
  if (!isFullMissionMap(map) && map.taskPage) return map
  const whole = plan(map)
  const { window, pinned, pinsOmitted, attention: urgent, omittedAttention } = shown(map, whole)
  const attention = { ...urgent, keys: omittedAttention.slice(0, MISSION_TASK_PAGE).map(task => task.key) }
  const { tasks, reports } = rows(map, whole, [...window, ...pinned])
  // Mission-wide readouts and reports of tasks the map no longer has: the newest.
  const known = new Set(map.tasks.map(task => task.key)), byKey = new Map(map.tasks.map(task => [task.key, task as AnyTask]))
  const taskless = map.reports.filter(value => !known.has(value.taskKey)).slice(-MISSION_PINNED_REPORTS).map(value => reportRow(map, byKey, value, true))
  const header = isFullMissionMap(map) ? {
    ...without(map, [...MISSION_BODY_FIELDS.mission, "frontier", "claims"]),
    bodies: described(map, MISSION_BODY_FIELDS.mission), excerpt: missionObjectiveLabel(map.objective),
    ...(map.briefing ? { briefing: without(map.briefing, MISSION_BRIEFING_CONTENT) } : {}),
  } : without(map as MissionPanelMap & Partial<Pick<MissionMap, "frontier" | "claims">>, ["frontier", "claims"])
  const history = (map.history as Array<MissionPlanChange | MissionPanelPlanChange>).map((change): MissionPanelPlanChange => ({
    ...without(change as MissionPlanChange, MISSION_BODY_FIELDS.change), bodies: described(change, MISSION_BODY_FIELDS.change),
    ...(typeof (change as MissionPlanChange).reason === "string" ? { excerpt: missionExcerpt((change as MissionPlanChange).reason!) } : {}),
  }))
  return { ...header, tasks, reports: [...reports, ...taskless], history, actorEvidence: evidence(map, whole.ordered),
    taskPage: { ...whole.page, offset: 0, end: window.length, ...(pinsOmitted ? { pinsOmitted } : {}), attention } } as MissionPanelMap
}

/** One page of `map`'s tasks (`MissionControl.tasks`): the window of `MISSION_TASK_PAGE`
 * at `offset` in the display order, the window at `attention` of the tasks needing action
 * that the map omits (its `taskPage.attention` with that window's `offset` and `end`), or
 * the tasks named by key, ID or report (at most `MISSION_TASK_PAGE` names in all, each
 * task named answered), as compact rows in display order with their reports (and the named
 * reports) and the map's `taskPage`. */
export function missionTaskPage(map: AnyMap, request: MissionTaskRequest) {
  const whole = plan(map), { omittedAttention, attention } = shown(map, whole)
  const reportIds = new Set(request.reportIds), reports = map.reports.filter(value => reportIds.has(value.id))
  if (request.attention !== undefined) {
    const offset = Math.min(request.attention, omittedAttention.length), selected = omittedAttention.slice(offset, offset + MISSION_TASK_PAGE)
    return { taskPage: { ...whole.page, offset: 0, end: 0, attention: { ...attention, offset, end: offset + selected.length } } as MissionTaskPage, ...rows(map, whole, selected) }
  }
  const offset = Math.min(request.offset ?? 0, whole.page.total)
  const named = new Set([...request.keys ?? [], ...reports.map(value => value.taskKey)])
  const ids = new Set(request.ids)
  const selected = request.offset !== undefined ? whole.ordered.slice(offset, offset + MISSION_TASK_PAGE)
    : whole.ordered.filter(task => named.has(task.key) || ids.has(task.id))
  const end = request.offset !== undefined ? offset + selected.length : offset
  return { taskPage: { ...whole.page, offset, end, attention } as MissionTaskPage, ...rows(map, whole, selected, new Set(reports.map(value => value.id))) }
}

/** `read` with its maps compact (`compactMissionMap`): what the list and mission reads return. */
export function compactMissionReads<T extends { missions: readonly AnyMap[] }>(read: T): Omit<T, "missions"> & { missions: MissionPanelMap[] } {
  return { ...read, missions: read.missions.map(compactMissionMap) }
}
