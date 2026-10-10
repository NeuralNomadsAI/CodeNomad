import { z } from "zod"
import { recurrenceIDSchema, recurrenceControlRecordSchema } from "./recurrence-contract"
import { dailyClockSchema } from "./recurrence-clock"

export const recurrenceControlRequestSchema = z.object({ scheduleID: recurrenceIDSchema,
  requestID: recurrenceIDSchema, action: z.enum(["play", "pause", "stop", "resume", "run-now", "check"]),
  expectedRevision: z.number().int().nonnegative().safe(),
}).strict()
export type RecurrenceControlRequest = z.infer<typeof recurrenceControlRequestSchema>
/** Desired state committed by a control; Run now has none. */
export function recurrenceControlTargetState(action: RecurrenceControlRequest["action"]) {
  return action === "play" || action === "resume" ? "running" : action === "pause" || action === "check" ? "paused"
    : action === "stop" ? "stopped" : undefined
}
/** Check keeps whichever inactive state it observed: paused, or terminal stopped. */
export function recurrenceControlStateMatches(action: RecurrenceControlRequest["action"], state: string | undefined) {
  return action === "check" ? state === "paused" || state === "stopped" : state === recurrenceControlTargetState(action)
}
export const recurrenceControlHttpSchema = recurrenceControlRequestSchema.extend({
  directory: z.string().min(1).max(4096).optional(), retry: z.boolean().optional(),
}).refine(input => !input.retry || input.action === "pause" || input.action === "stop", "Only partial denial controls can be retried")
export const recurrenceControlStatusSchema = recurrenceControlRecordSchema.omit({ action: true, targetsKnown: true }).partial({
  revision: true, state: true, controlsComplete: true, targets: true,
}).extend({ version: z.literal(1), scheduleID: recurrenceIDSchema, outcome: z.enum(["committed", "unknown"]),
  action: z.enum(["play", "pause", "stop", "resume", "run-now", "check"]).optional() })
  .refine(value => value.outcome !== "committed" || value.controlsComplete === true)
  .refine(value => value.controlsComplete !== true || value.schedulerCancellation !== "unknown"
    && (value.targets?.every(target => target.outcome === "acknowledged") ?? true), "Unknown targets/cancellation are not completed controls")
export type RecurrenceControlStatus = z.infer<typeof recurrenceControlStatusSchema>
export const recurrenceNativeControlSchema = recurrenceControlRecordSchema
export const recurrenceNativeControlWire = { type: "object", properties: {
  sessionID: { type: "string" }, outcome: { type: "string", enum: ["acknowledged", "unknown"] },
}, required: ["sessionID", "outcome"], additionalProperties: false } as const
export const recurrenceControlRequestWire = { type: "object", properties: {
  scheduleID: { type: "string", minLength: 3, maxLength: 100 },
  requestID: { type: "string", minLength: 3, maxLength: 100 },
  action: { type: "string", enum: ["play", "pause", "stop", "resume", "run-now", "check"] },
  expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
}, required: ["scheduleID", "requestID", "action", "expectedRevision"], additionalProperties: false } as const

const timestamp = z.number().int().nonnegative().safe()
const reference = z.object({ passageID: recurrenceIDSchema, dueAt: timestamp, settledAt: timestamp,
  outcome: z.enum(["completed", "failed", "ended-without-report"]), reason: z.enum(["interrupted", "not-started"]).optional(),
  trigger: z.enum(["daily", "manual"]).optional(), missionID: z.string().optional(), conversationID: z.string().optional() }).strict().refine(value => value.settledAt >= value.dueAt)
export const recurrenceSnapshotSchema = z.object({ version: z.literal(1), projectID: z.string().min(1).max(240),
  projectCanonical: z.string().min(1).max(4096), location: z.object({ directory: z.string().min(1).max(4096), workspaceID: z.string().optional() }).strict(),
  schedules: z.array(z.object({ id: recurrenceIDSchema, title: z.string().min(1).max(120), revision: timestamp,
    state: z.enum(["paused", "running", "interrupted", "stopped"]), clock: dailyClockSchema, nextDueAt: timestamp.nullable(),
    interruptionReason: z.enum(["service-restart", "error"]).optional(),
    lastError: z.object({ code: z.enum(["wake-failed", "admission-failed", "settlement-failed"]), at: timestamp }).strict().optional(),
    pending: z.object({ passageID: recurrenceIDSchema, status: z.enum(["starting", "running", "settling", "uncertain"]),
      trigger: z.enum(["daily", "manual"]).optional(), reason: z.enum(["not-observed", "admission-failing"]).optional(),
      missionID: z.string().optional(), conversationID: z.string().optional() }).strict().nullable(),
    latestResult: reference.nullable(), history: z.array(reference).max(30),
    actions: z.array(z.enum(["play", "pause", "stop", "resume", "run-now", "check"])).max(6).refine(items => new Set(items).size === items.length),
    controls: z.array(recurrenceControlStatusSchema).max(64),
  }).strict().refine(value => (value.state === "running") === (value.nextDueAt !== null)
    && JSON.stringify(value.latestResult) === JSON.stringify(value.history.at(-1) ?? null)
    && new Set(value.history.map(item => item.passageID)).size === value.history.length
    && !value.history.some(item => item.passageID === value.pending?.passageID)
    && value.controls.every(item => item.scheduleID === value.id))).max(64),
}).strict()

const numberWire = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const
const referenceWire = { type: ["object", "null"], properties: { passageID: { type: "string" }, dueAt: numberWire,
  settledAt: numberWire, outcome: { type: "string", enum: ["completed", "failed", "ended-without-report"] },
  reason: { type: "string", enum: ["interrupted", "not-started"] },
  trigger: { type: "string", enum: ["daily", "manual"] }, missionID: { type: "string" }, conversationID: { type: "string" } },
  required: ["passageID", "dueAt", "settledAt", "outcome"], additionalProperties: false } as const
export const recurrenceControlStatusWire = { type: "object", properties: { version: { type: "integer", const: 1 },
  scheduleID: { type: "string" }, requestID: { type: "string" }, expectedRevision: numberWire, revision: numberWire,
  state: { type: "string", enum: ["paused", "running", "stopped"] }, outcome: { type: "string", enum: ["committed", "unknown"] },
  action: { type: "string", enum: ["play", "pause", "stop", "resume", "run-now", "check"] },
  controlsComplete: { type: "boolean" }, schedulerCancellation: { type: "string", enum: ["acknowledged", "unknown"] },
  targets: { type: "array", maxItems: 32, items: recurrenceNativeControlWire } },
  required: ["version", "scheduleID", "requestID", "expectedRevision", "outcome"], additionalProperties: false } as const
export const recurrenceSnapshotOutput = { type: "object", properties: { version: { type: "integer", const: 1 },
  projectID: { type: "string" }, projectCanonical: { type: "string" }, location: { type: "object", properties: {
    directory: { type: "string" }, workspaceID: { type: "string" } }, required: ["directory"], additionalProperties: false },
  schedules: { type: "array", maxItems: 64, items: { type: "object", properties: {
    id: { type: "string" }, title: { type: "string", minLength: 1, maxLength: 120 }, revision: numberWire,
    state: { type: "string", enum: ["paused", "running", "interrupted", "stopped"] },
    clock: { type: "object", properties: { time: { type: "string" }, zone: { type: "string" } }, required: ["time", "zone"], additionalProperties: false },
    nextDueAt: { type: ["integer", "null"], minimum: 0 }, interruptionReason: { type: "string", enum: ["service-restart", "error"] },
    lastError: { type: "object", properties: { code: { type: "string", enum: ["wake-failed", "admission-failed", "settlement-failed"] }, at: numberWire },
      required: ["code", "at"], additionalProperties: false },
    pending: { type: ["object", "null"], properties: { passageID: { type: "string" }, status: { type: "string", enum: ["starting", "running", "settling", "uncertain"] },
      trigger: { type: "string", enum: ["daily", "manual"] }, reason: { type: "string", enum: ["not-observed", "admission-failing"] },
      missionID: { type: "string" }, conversationID: { type: "string" } }, required: ["passageID", "status"], additionalProperties: false },
    latestResult: referenceWire, history: { type: "array", maxItems: 30, items: { ...referenceWire, type: "object" } },
    actions: { type: "array", maxItems: 6, uniqueItems: true, items: { type: "string", enum: ["play", "pause", "stop", "resume", "run-now", "check"] } },
    controls: { type: "array", maxItems: 64, items: recurrenceControlStatusWire },
  }, required: ["id", "title", "revision", "state", "clock", "nextDueAt", "pending", "latestResult", "history", "actions", "controls"], additionalProperties: false } },
}, required: ["version", "projectID", "projectCanonical", "location", "schedules"], additionalProperties: false } as const
