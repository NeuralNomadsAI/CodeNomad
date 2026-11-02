import { z } from "zod"
import { taskCount as count, taskDigest as digest, taskRowSchema } from "./mission-task-page-schema"
import { parseMissionProfiles } from "../../../server/src/missions/playbook-profiles"

const id = z.string().min(1).max(240), state = z.enum(["active", "completed", "failed", "stopped"])
export const panelWindowSchema = z.object({ order: digest, offset: count, end: count, total: count }).strict()
  .refine(value => value.offset <= value.end && value.end <= value.total)
const body = z.object({ characters: count, digest }).strict()
export const panelSummarySchema = z.object({ id, title: z.string().max(60).optional(), objective: z.string().max(1004), status: state,
  runState: z.enum(["prepared", "running", "paused", "stopped"]).optional(), coordinatorSessionId: id, actorCount: count,
  updatedAt: z.number().finite(), revision: count, finishSequence: count.positive().optional() }).strict()
export const panelCleanupSchema = z.object({ missionID: id, deletionID: id, requestID: id, expectedRevision: count.positive(), deleteManagedSessions: z.boolean(),
  objective: z.string().max(240), createdAt: z.number().finite(), removed: count, retained: count, pending: count,
  reasons: z.array(z.enum(["children", "shared", "moved", "identity", "guarded"])).max(5), documentPending: z.boolean().optional() }).passthrough()
export const panelControlSchema = z.object({ id, requestID: id, expectedRevision: count, completedRevision: count.optional(), action: z.enum(["start", "pause", "stop"]),
  graceful: z.literal(true).optional(), pending: count, receipts: count, unconfirmedReceipts: count, partialDescendants: count }).strict()
export const panelHeaderSchema = z.object({ root: z.object({ version: z.literal(1), id, projectID: id, projectCanonical: z.string().min(1).max(20_000),
  title: z.string().max(60).optional(), excerpt: z.string().max(1004), template: z.enum(["custom", "debug", "wayfinder", "delivery", "compare"]), status: state,
  runState: z.enum(["prepared", "running", "paused", "stopped"]).optional(), coordinatorSessionId: id, revision: count, createdAt: z.number().finite(), updatedAt: z.number().finite(),
  finishSequence: count.positive().optional(), historyTruncated: z.boolean(), bodies: z.record(body), taskMode: z.enum(["native", "independent"]).optional(),
  profiles: z.unknown().refine(value => { try { parseMissionProfiles(value); return true } catch { return false } }).optional(),
  briefing: z.object({ id, requestID: z.string().min(1).max(128), basedOnRevision: count, basedOnUpdatedAt: count, createdAt: count }).strict().optional(),
  briefingResponses: z.array(z.object({ requestID: z.string().min(1).max(128), briefingID: id }).strict()).max(16).optional(),
  preparedBy: z.object({ missionId: id, coordinatorSessionId: id }).strict().optional(),
  controlUnavailable: z.boolean().optional(), notificationUnavailable: z.boolean().optional(),
  objective: z.never().optional(), notes: z.never().optional(), summary: z.never().optional(), actors: z.never().optional(), tasks: z.never().optional(), reports: z.never().optional(),
  history: z.never().optional(), frontier: z.never().optional(), claims: z.never().optional(), control: z.never().optional(), actorEvidence: z.never().optional(), taskPage: z.never().optional(),
}).passthrough(), collections: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(64), body.extend({ total: count, array: z.boolean(), order: digest.optional() }).strict()),
  tasks: z.object({ page: taskRowSchema.shape.taskPage, pins: z.array(id).max(20), reportPins: z.array(id).max(8), version: digest }).strict(),
  control: panelControlSchema.optional(), coordinator: z.object({ sessionId: id, kind: z.literal("coordinator"), managed: z.boolean(), title: z.string().max(240),
    roles: z.array(z.string().max(240)).max(2000), location: z.object({ directory: z.string().min(1).max(20_000), workspaceID: id.optional() }).strict(), joinedAt: z.number().finite() }).strict().optional() }).strict()
  .refine(value => !value.coordinator || value.coordinator.sessionId === value.root.coordinatorSessionId)
  .refine(value => value.collections.actors?.array === true && value.collections.reports?.array === true && value.collections.history?.array === true
    && value.tasks.page.reports === value.collections.reports.total && value.tasks.page.offset === 0 && value.tasks.page.end === Math.min(50, value.tasks.page.total)
    && Object.values(value.tasks.page.counts).reduce((sum, number) => sum + number, 0) === value.tasks.page.total
    && new Set(value.tasks.pins).size === value.tasks.pins.length && value.tasks.page.end + value.tasks.pins.length <= value.tasks.page.total
    && (!value.control || value.control.unconfirmedReceipts <= value.control.receipts && value.control.partialDescendants <= value.control.receipts
      && value.control.expectedRevision <= value.root.revision && (value.control.completedRevision ?? 0) <= value.root.revision))
export const panelActorSchema = z.object({ sessionId: id, title: z.string().max(240), location: z.object({ directory: z.string().min(1).max(20_000), workspaceID: id.optional() }).strict(),
  reportOwed: z.boolean(), callOpen: z.boolean(), taskContext: z.object({ invalid: z.boolean(), taskKey: z.string().max(64).optional(), parentSessionID: id.optional() }).strict().optional() }).strict()
export const panelPersistedActorSchema = panelActorSchema.pick({ sessionId: true, title: true, location: true }).extend({ kind: z.enum(["coordinator", "specialist"]), managed: z.boolean(),
  roles: z.array(z.string().max(240)).max(2000), joinedAt: z.number().finite() }).passthrough()
export const panelHistorySchema = z.object({ revision: count, createdAt: z.number().finite(), source: z.enum(["user", "coordinator"]).optional(), actorSessionId: id.optional(),
  excerpt: z.string().max(482).optional(), bodies: z.record(body).optional(), reason: z.never().optional(), objective: z.never().optional(), notes: z.never().optional(),
  addedTaskKeys: z.never().optional(), retiredTasks: z.never().optional(), dependencyUpdates: z.never().optional() }).passthrough()
export const panelReportSchema = taskRowSchema.shape.reports.element
const evidenceState = z.enum(["observed", "partial", "unknown"])
const observedRequest = z.object({ kind: z.enum(["form", "permission"]), actorSessionId: id,
  request: z.object({ id, sessionID: id }).passthrough() }).strict().refine(item => item.kind === "form"
  ? typeof item.request.title === "string" && Array.isArray(item.request.fields)
  : (item.request.action === undefined || typeof item.request.action === "string") && (item.request.resources === undefined
    || Array.isArray(item.request.resources) && item.request.resources.every(value => typeof value === "string")))
export const panelObservationSchema = z.object({ context: z.object({ id, projectID: id, revision: count, status: state,
  runState: z.enum(["prepared", "running", "paused", "stopped"]).optional(), coordinatorSessionId: id, actors: z.array(panelActorSchema).max(160), actorPage: panelWindowSchema,
  control: panelControlSchema.optional(), discardedEvents: count, controlUnavailable: z.boolean(), notificationUnavailable: z.boolean(), cleanupUnavailable: z.boolean() }).strict(),
  coverage: evidenceState, requests: z.object({ state: evidenceState, items: z.array(observedRequest) }).strict(),
  activity: z.object({ actors: z.array(z.object({ sessionId: id, state: z.enum(["running", "queued", "background", "permission", "form", "missing", "idle-without-report", "unknown"]) }).strict()).max(160),
    family: z.object({ state: evidenceState, members: z.array(z.object({ sessionId: id, parentSessionId: id.optional(), actorSessionId: id,
      kind: z.enum(["declared", "ordinary"]).optional(), taskKey: z.string().max(64).optional() }).strict()).max(160 * 33) }).strict() }).strict(),
}).strict().superRefine((value, ctx) => {
  const { context, activity, requests } = value, roots = new Set(context.actors.map(actor => actor.sessionId)), page = context.actorPage
  const members = new Map(activity.family.members.map(member => [member.sessionId, member]))
  if (roots.size !== context.actors.length || page.end - page.offset !== roots.size || new Set(activity.actors.map(actor => actor.sessionId)).size !== roots.size
    || activity.actors.some(actor => !roots.has(actor.sessionId)) || members.size !== activity.family.members.length
    || activity.family.members.some(member => !roots.has(member.actorSessionId))
    || requests.items.some(item => !roots.has(item.actorSessionId) || item.request.sessionID !== item.actorSessionId && members.get(item.request.sessionID)?.actorSessionId !== item.actorSessionId)
    || page.total > roots.size && (value.coverage === "observed" || requests.state === "observed")) ctx.addIssue({ code: "custom", message: "Invalid observation membership/coverage" })
})
export const panelMarksSchema = z.object({ missionPage: panelWindowSchema, observations: z.array(panelObservationSchema).max(16) }).strict()
  .refine(value => value.observations.length === value.missionPage.end - value.missionPage.offset
    && new Set(value.observations.map(item => item.context.id)).size === value.observations.length && value.observations.every(item => item.context.actors.length <= 10))
export type PanelHeader = z.infer<typeof panelHeaderSchema>
export type PanelObservation = z.infer<typeof panelObservationSchema>
