import type { MissionPanelMap, MissionPanelReport, MissionPanelTask } from "../../../server/src/api-types"
import { missionBodyOwner, type MissionContentSelector } from "../../../server/src/missions/mission-content-wire"
import type { MissionTaskAttention, MissionTaskRequest } from "../../../server/src/missions/mission-panel-map"
import type { MissionTaskPageFailure } from "../lib/mission-task-page-read"

/** A value a page answered, with that page's revision. */
interface Read<T> { value: T; revision: number }

/** The attention windows (`MissionTaskAttention`) answered for one sequence: by offset, their ends. */
export interface MissionTaskAttentionCoverage { sequence: string; revision: number; windows: Map<number, number> }

/** Rows read further into one compact map (`MissionStore.loadTasks`), kept across list
 * reads of the same display order, and what was read, to read it again. Each row, report
 * and read keeps its own revision: a page vouches only for what it answered. */
export interface MissionTaskPageCache {
  order: string
  rows: Map<string, Read<MissionPanelTask>>
  reports: Map<string, Read<MissionPanelReport>>
  /** Every read made, by unit (`o:` a window's offset, `a:` an attention window's, `k:` a
   * key, `i:` an ID, `r:` a report ID), with the revision of its last answer (0 before one). */
  reads: Map<string, number>
  /** Reads that failed, with the map's revision then: parked until a later revision. */
  parked: Map<string, number>
  /** Failed reads by request, kept until a read answers every unit of theirs. */
  failures: Map<string, { error: string; request: MissionTaskRequest; reason?: MissionTaskPageFailure }>
  attention?: MissionTaskAttentionCoverage
}

export function createTaskPageCache(order: string): MissionTaskPageCache {
  return { order, rows: new Map(), reports: new Map(), reads: new Map(), parked: new Map(), failures: new Map() }
}

/** `cache` for another display order: its rows, coverage and failures go, the reads it
 * records stay, to read again. */
export function reorderTaskPageCache(cache: MissionTaskPageCache, order: string): void {
  cache.order = order
  cache.rows.clear()
  cache.reports.clear()
  cache.parked.clear()
  cache.failures.clear()
  cache.attention = undefined
  for (const unit of cache.reads.keys()) cache.reads.set(unit, 0)
}

/** Parks `request` after it failed while the map was at `revision`, and keeps its failure
 * until a read answers it, whatever reads succeed meanwhile. */
export function failTaskRequest(cache: MissionTaskPageCache, request: MissionTaskRequest, revision: number, error: string, reason?: MissionTaskPageFailure): void {
  for (const unit of units(request)) cache.parked.set(unit, revision)
  cache.failures.set(JSON.stringify(units(request)), { error, request, ...(reason ? { reason } : {}) })
}

const units = (request: MissionTaskRequest) => [...request.offset !== undefined ? [`o:${request.offset}`] : [],
  ...request.attention !== undefined ? [`a:${request.attention}`] : [], ...(request.keys ?? []).map(key => `k:${key}`),
  ...(request.ids ?? []).map(id => `i:${id}`), ...(request.reportIds ?? []).map(id => `r:${id}`)]

/** Records `request` before it is sent: a read the order refuses is read again in the next. */
export function recordTaskRequest(cache: MissionTaskPageCache, request: MissionTaskRequest): void {
  for (const unit of units(request)) if (!cache.reads.has(unit)) cache.reads.set(unit, 0)
}

/** The revision of the page each row or report value read further was answered at:
 * a body it describes is no older than that (`missionBodyRevision`). */
const observed = new WeakMap<object, number>()

/** Stores a page's answer to `request` at `revision`: its rows, reports and reads, each
 * unless the cache holds a later answer; the failures it answers go, and an attention
 * window counts for its sequence, at the newest revision answered. */
export function answerTaskRequest(cache: MissionTaskPageCache, request: MissionTaskRequest, revision: number,
  page: { tasks: readonly MissionPanelTask[]; reports: readonly MissionPanelReport[]; attention?: MissionTaskAttention }): void {
  for (const row of page.tasks) if ((cache.rows.get(row.id)?.revision ?? -1) <= revision) { cache.rows.set(row.id, { value: row, revision }); observed.set(row, revision) }
  for (const report of page.reports) if ((cache.reports.get(report.id)?.revision ?? -1) <= revision) { cache.reports.set(report.id, { value: report, revision }); observed.set(report, revision) }
  const answered = new Set(units(request))
  for (const unit of answered) { cache.reads.set(unit, Math.max(cache.reads.get(unit) ?? 0, revision)); cache.parked.delete(unit) }
  for (const [key, failure] of cache.failures) if (units(failure.request).every(unit => answered.has(unit))) cache.failures.delete(key)
  const attention = page.attention
  if (request.attention !== undefined && attention?.offset !== undefined && attention.end !== undefined) {
    if (!coverAttention(cache, attention.sequence, revision)) return
    cache.attention!.windows.set(attention.offset, attention.end)
  }
}

/** Makes `cache`'s attention coverage that of `sequence` at `revision`, unless it holds a
 * later one: another sequence covers nothing yet. False when the coverage is later. */
export function coverAttention(cache: MissionTaskPageCache, sequence: string, revision: number): boolean {
  const current = cache.attention
  if (current && current.revision > revision) return false
  if (current?.sequence !== sequence) cache.attention = { sequence, revision, windows: new Map() }
  else current.revision = revision
  return true
}

/** The revision a body `selector` names in `mission` is expected at: the map's, or the page
 * that answered its owner (a row or report read further), whichever is later. The map's own
 * fields keep the map's revision. */
export function missionBodyRevision(mission: MissionPanelMap, selector: MissionContentSelector): number {
  const owner = missionBodyOwner(mission, selector)
  return Math.max(mission.revision, (owner && observed.get(owner)) ?? 0)
}

/** A task's history (its content field `reports`) that `mission`'s row describes by no
 * descriptor (an older plugin's compact map): its report count and newest report stand in,
 * so a history shown under other ones is read again. Undefined when a descriptor describes it. */
export function missionHistoryMark(mission: MissionPanelMap, selector: MissionContentSelector): string | undefined {
  if (selector.kind !== "task" || selector.field !== "reports" || !mission.taskPage) return undefined
  const row = mission.tasks.find(task => task.key === selector.taskKey)
  if (!row || row.bodies?.reports) return undefined
  const newest = [...mission.reports.filter(report => report.taskKey === row.key), ...row.report ? [row.report] : [], ...row.lateReports ?? []]
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0]
  return JSON.stringify([row.reportCount ?? null, newest?.id ?? null])
}

/** The requests that read again what `cache` read before `revision`, each within one page;
 * a read parked at `revision` or later waits for a later one, or an explicit read. */
export function taskRequestsOf(cache: MissionTaskPageCache, page: number, revision: number): MissionTaskRequest[] {
  const stale = [...cache.reads].filter(([unit, answered]) => answered < revision && (cache.parked.get(unit) ?? -1) < revision).map(([unit]) => unit)
  const of = (prefix: string) => stale.filter(unit => unit.startsWith(prefix)).map(unit => unit.slice(2))
  const chunks = (values: string[]) => Array.from({ length: Math.ceil(values.length / page) }, (_, index) => values.slice(index * page, (index + 1) * page))
  return [...of("o:").map(Number).sort((left, right) => left - right).map(offset => ({ offset })),
    ...of("a:").map(Number).sort((left, right) => left - right).map(attention => ({ attention })),
    ...chunks(of("k:")).map(keys => ({ keys })), ...chunks(of("i:")).map(ids => ({ ids })), ...chunks(of("r:")).map(reportIds => ({ reportIds }))]
}

/** `base` (a list read's own map) with the rows `cache` holds of the same display order, in
 * that order: a row or report the base holds stays unless a page answered it at a later
 * revision; one it does not hold shows as last read. Another order shows the base alone. */
export function mergeTaskPages(base: MissionPanelMap, cache: MissionTaskPageCache | undefined): MissionPanelMap {
  if (!cache || !base.taskPage || base.taskPage.order !== cache.order || !cache.rows.size) return base
  const tasks = new Map(base.tasks.map(task => [task.id, task]))
  for (const [id, row] of cache.rows) if (!tasks.has(id) || row.revision > base.revision) tasks.set(id, row.value)
  const reports = new Map(base.reports.map(report => [report.id, report]))
  for (const [id, report] of cache.reports) if (!reports.has(id) || report.revision > base.revision) reports.set(id, report.value)
  return { ...base, tasks: [...tasks.values()].sort((left, right) => (left.order ?? 0) - (right.order ?? 0)), reports: [...reports.values()] }
}
