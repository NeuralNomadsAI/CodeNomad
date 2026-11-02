import { z } from "zod"
import { Exit, Schema, SchemaRepresentation } from "effect"
import { parseExecution } from "../../../server/src/missions/execution"
import { parseExecutionMode } from "../../../server/src/missions/task-execution-mode"
import { missionTaskExecutionEvidence } from "../../../server/src/missions/execution-evidence"
import { nativeCallBindingSchema, nativeTaskBindingSchema, nativeTaskExecutionSchema } from "../../../server/src/missions/native-wire-schema"
import { MISSION_LATE_REPORT_ROWS, MISSION_TASK_PAGE, MISSION_TASK_REPORT_ROWS, type MissionPanelTask, type MissionPanelReport, type MissionTaskRequest, type MissionTaskPage, type MissionTaskAttention } from "../../../server/src/missions/mission-panel-map"

export interface MissionTaskPageContext {
  revision: number; order: string; total: number; reports: number; counts: MissionTaskPage["counts"]; excludedKeys: readonly string[]
  attention?: Pick<MissionTaskAttention, "sequence" | "omitted" | "keys">
}

export const taskCount = z.number().int().nonnegative().safe(), taskDigest = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const short = z.string().min(1).max(240), excerpt = z.string().max(482)
const status = z.enum(["blocked", "ready", "dispatching", "queued", "completed", "needs-input", "failed", "withdrawn"])
const bodies = z.record(z.string().min(1).max(64), z.object({ characters: taskCount, digest: taskDigest }).strict())
  .refine(value => Object.keys(value).length <= 64)
const parses = (read: (value: unknown) => unknown, value: unknown) => { try { read(value); return true } catch { return false } }
const nativeDecoder = (schema: Parameters<typeof SchemaRepresentation.fromJsonSchemaDocument>[0]["schema"]) => Schema.decodeUnknownExit(Schema.toType(SchemaRepresentation.fromJsonSchemaDocument({
  dialect: "draft-2020-12", schema, definitions: {},
})), { onExcessProperty: "error" })
const binding = nativeDecoder(nativeCallBindingSchema), originalBinding = nativeDecoder(nativeTaskBindingSchema)
const { observations: _observations, ...compactExecutionProperties } = nativeTaskExecutionSchema.properties
const execution = nativeDecoder({ ...nativeTaskExecutionSchema, properties: compactExecutionProperties })
const report = z.object({ id: short, taskKey: z.string().max(240), sessionId: short, outcome: z.enum(["completed", "blocked", "failed"]), createdAt: taskCount,
  excerpt: excerpt.optional(), bodies: bodies.optional(), late: z.boolean().optional(), decidedBy: z.enum(["human", "coordinator"]).optional(),
  nativeCall: z.custom<NonNullable<MissionPanelReport["nativeCall"]>>(value => Exit.isSuccess(binding(value))).optional(),
  delivery: z.enum(["coordinator-notification", "native-return", "coordinator-readout"]).optional(), notificationStatus: z.enum(["pending", "admitted"]).optional(),
  summary: z.never().optional(), evidence: z.never().optional(), next: z.never().optional(), artifact: z.never().optional(),
}).passthrough()
const mode = z.union([
  z.object({ kind: z.literal("native"), parentTaskKey: z.string().nullable(), reuseFromTaskKey: z.string().optional() }).strict(),
  z.object({ kind: z.literal("independent"), reason: z.enum(["location", "lifetime", "existing-root", "playbook"]), excerpt: excerpt.optional() }).strict(),
]).refine(value => value.kind === "independent" && value.excerpt === undefined
  || parses(parseExecutionMode, value.kind === "native" ? value : { kind: value.kind, reason: value.reason, explanation: value.excerpt }))
const task = z.object({ id: short, key: short, title: z.string().max(240), role: short, status, blockedBy: z.array(short).max(24),
  order: taskCount, createdAt: taskCount, updatedAt: taskCount, outstandingExecution: z.boolean(), dependents: taskCount, reportCount: taskCount,
  lateReportCount: taskCount.optional(), actorSessionId: short.optional(), admissionId: short.optional(), replacesTaskKey: short.optional(), replacedByTaskKey: short.optional(),
  contractGeneration: taskCount.positive().optional(), delivery: z.enum(["queue", "steer"]).optional(), bodies: bodies.optional(),
  report: report.optional(), lateReports: z.array(report).max(MISSION_LATE_REPORT_ROWS).optional(), brief: z.never().optional(),
  execution: z.custom<NonNullable<MissionPanelTask["execution"]>>(value => parses(parseExecution, value)).optional(), executionMode: mode.optional(),
  nativeBinding: z.custom<NonNullable<MissionPanelTask["nativeBinding"]>>(value => Exit.isSuccess(originalBinding(value))).optional(),
  nativeExecution: z.custom<NonNullable<MissionPanelTask["nativeExecution"]>>(value => Exit.isSuccess(execution(value))).optional(),
}).passthrough()
export const taskRowSchema = z.object({ taskPage: z.object({ order: taskDigest, offset: taskCount, end: taskCount, total: taskCount,
  counts: z.record(status, taskCount), reports: taskCount, pinsOmitted: taskCount.optional(),
  attention: z.object({ counts: z.object({ notifications: taskCount, blocked: taskCount, failed: taskCount, recovery: taskCount }).strict(),
    omitted: taskCount, sequence: taskDigest, keys: z.array(short).max(MISSION_TASK_PAGE).optional(), offset: taskCount.optional(), end: taskCount.optional() }).passthrough().optional(),
}).passthrough(), tasks: z.array(task).max(MISSION_TASK_PAGE), reports: z.array(report).max(MISSION_TASK_PAGE * (MISSION_TASK_REPORT_ROWS + 1)) }).passthrough()

/** Contradictions observable in this window only; no claim to reconstruct omitted
 * priority order or establish the existence of an unreturned name. */
export function validTaskSelection(request: MissionTaskRequest, row: { taskPage: MissionTaskPage; tasks: MissionPanelTask[]; reports: MissionPanelReport[] },
  context?: MissionTaskPageContext, revision?: number): boolean {
  const { taskPage: page, tasks, reports } = row, namedReports = new Set(request.reportIds), keys = new Set(request.keys), ids = new Set(request.ids)
  if (context?.order === page.order && context.total !== page.total) return false // the order digest commits the complete key sequence
  if (context?.order === page.order && context.revision === revision && (context.reports !== page.reports
    || status.options.some(key => (context.counts[key] ?? 0) !== (page.counts[key] ?? 0)))) return false
  const selectedKeys = new Set(tasks.map(task => task.key)), counts = Object.values(page.counts).reduce((sum, value) => sum + (value ?? 0), 0)
  const unique = (values: unknown[]) => new Set(values).size === values.length
  if (counts !== page.total || !Number.isSafeInteger(counts) || page.offset > page.end || page.end > page.total || reports.length > page.reports
    || !unique(tasks.map(task => task.id)) || !unique(tasks.map(task => task.key)) || !unique(tasks.map(task => task.order)) || !unique(reports.map(report => report.id))) return false
  const statuses = new Map<string, number>()
  for (const task of tasks) {
    statuses.set(task.status, (statuses.get(task.status) ?? 0) + 1)
    if (task.order === undefined || task.order >= page.total || task.reportCount! > page.reports || task.dependents! > page.total
      || task.report && task.report.taskKey !== task.key || task.lateReports?.some(report => report.taskKey !== task.key)
      || (task.lateReportCount ?? 0) < (task.lateReports?.length ?? 0) || (task.lateReportCount ?? 0) > task.reportCount!) return false
    const own = reports.filter(report => report.taskKey === task.key)
    const nestedReports = [...task.report ? [task.report] : [], ...task.lateReports ?? []]
    if (own.length > task.reportCount! || own.filter(report => !namedReports.has(report.id)).length > MISSION_TASK_REPORT_ROWS
      || new Set(nestedReports.map(report => report.id)).size > task.reportCount!) return false
    for (const nested of nestedReports) {
      const top = reports.find(report => report.id === nested.id)
      if (!top || ["taskKey", "sessionId", "outcome", "createdAt", "delivery", "notificationStatus", "late", "decidedBy", "excerpt"].some(key =>
        top[key as keyof MissionPanelReport] !== nested[key as keyof MissionPanelReport])) return false
      const a = top.nativeCall, b = nested.nativeCall
      if ((a === undefined) !== (b === undefined) || a && b && (["generation", "parentSessionID", "parentMessageID", "toolCallID"] as const).some(key => a[key] !== b[key])) return false
    }
    if (request.offset === undefined && request.attention === undefined && !keys.has(task.key) && !ids.has(task.id)
      && !reports.some(report => namedReports.has(report.id) && report.taskKey === task.key)) return false
  }
  if ([...statuses].some(([status, count]) => count > (page.counts[status as keyof typeof page.counts] ?? 0))) return false
  if (reports.some(report => !selectedKeys.has(report.taskKey) && !namedReports.has(report.id))) return false
  if (request.offset !== undefined && (page.offset !== Math.min(request.offset, page.total) || page.end !== Math.min(page.offset + MISSION_TASK_PAGE, page.total)
    || tasks.length !== page.end - page.offset || tasks.some(task => task.order! < page.offset || task.order! >= page.end))) return false
  if (request.offset === undefined && (page.offset !== 0 || page.end !== 0)) return false
  const attention = page.attention
  if (attention && (attention.omitted > page.total || Object.values(attention.counts).some(count => count > page.total)
    || attention.omitted > Object.values(attention.counts).reduce((sum, value) => sum + value, 0)
    || attention.counts.blocked !== (page.counts["needs-input"] ?? 0) || attention.counts.failed !== (page.counts.failed ?? 0)
    || tasks.filter(task => missionTaskExecutionEvidence(task).missingReport).length > attention.counts.recovery
    || tasks.filter(task => reports.some(report => report.taskKey === task.key && report.notificationStatus === "pending")).length > attention.counts.notifications
    || attention.keys && (!unique(attention.keys) || attention.keys.length > attention.omitted))) return false
  if (request.attention !== undefined) {
    if (!attention || attention.offset !== Math.min(request.attention, attention.omitted) || attention.end !== Math.min(attention.offset + MISSION_TASK_PAGE, attention.omitted)
      || tasks.length !== attention.end - attention.offset) return false
    for (const task of tasks) if (task.order! < MISSION_TASK_PAGE || !(task.status === "needs-input" || task.status === "failed"
      || missionTaskExecutionEvidence(task).missingReport || reports.some(report => report.taskKey === task.key && report.notificationStatus === "pending"))) return false
    // The base map identifies pins and the first omitted keys at its own revision.
    // Later revisions can legitimately change priority without changing task order.
    if (context && context.revision === revision && context.order === page.order) {
      if (context.excludedKeys.some(key => selectedKeys.has(key))) return false
      const expected = context.attention
      if (expected && (expected.sequence !== attention.sequence || expected.omitted !== attention.omitted)) return false
      if (expected?.keys?.some((key, index) => selectedKeys.has(key) !== (index >= attention.offset! && index < attention.end!))) return false
    }
  }
  return true
}
