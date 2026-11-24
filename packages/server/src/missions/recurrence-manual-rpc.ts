import { z } from "zod"
import { recurrenceIDSchema, recurrenceAdmissionSchema } from "./recurrence-contract"

export const recurrenceManualRequestSchema = z.object({ scheduleID: recurrenceIDSchema, requestID: recurrenceIDSchema,
  expectedRevision: z.number().int().nonnegative().safe() }).strict()
/** Native status input; `issuedAt` is the backend-held proof hint (see the control status). */
export const recurrenceManualStatusRequestSchema = recurrenceManualRequestSchema.extend({
  issuedAt: z.number().int().nonnegative().safe().optional() }).strict()
export const recurrenceManualResultSchema = recurrenceManualRequestSchema.extend({ version: z.literal(1),
  projectID: z.string().min(1).max(240), projectCanonical: z.string().min(1).max(4096),
  location: z.object({ directory: z.string().min(1).max(4096), workspaceID: z.string().optional() }).strict(),
  // `rejected`: native storage proves this exact Run now never reserved and never can.
  outcome: z.enum(["accepted", "settled", "unknown", "rejected"]), reason: z.enum(["revision-conflict", "control-conflict"]).optional(),
  passageID: recurrenceIDSchema.nullable(),
  messageID: recurrenceIDSchema.nullable(), admission: recurrenceAdmissionSchema.nullable(),
}).strict().refine(value => (value.passageID === null) === (value.messageID === null)
  && (!value.admission || value.admission.passageID === value.passageID && value.admission.messageID === value.messageID)
  && (value.outcome === "rejected") === (value.reason !== undefined) && (value.outcome !== "rejected" || value.passageID === null))
export type RecurrenceManualResult = z.infer<typeof recurrenceManualResultSchema>

const id = { type: "string", minLength: 3, maxLength: 100 } as const
export const RECURRENCE_RUN_NOW_STATUS_INPUT = { type: "object", properties: { scheduleID: id, requestID: id,
  expectedRevision: { type: "integer", minimum: 0 } }, required: ["scheduleID", "requestID", "expectedRevision"], additionalProperties: false } as const
export const RECURRENCE_RUN_NOW_STATUS_REQUEST = { ...RECURRENCE_RUN_NOW_STATUS_INPUT, properties: { ...RECURRENCE_RUN_NOW_STATUS_INPUT.properties,
  issuedAt: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } } as const
export const RECURRENCE_RUN_NOW_OUTPUT = { type: "object", properties: { ...RECURRENCE_RUN_NOW_STATUS_INPUT.properties,
  version: { type: "integer", const: 1 }, projectID: { type: "string" }, projectCanonical: { type: "string" },
  location: { type: "object", properties: { directory: { type: "string" }, workspaceID: { type: "string" } }, required: ["directory"], additionalProperties: false },
  outcome: { type: "string", enum: ["accepted", "settled", "unknown", "rejected"] },
  reason: { type: "string", enum: ["revision-conflict", "control-conflict"] }, passageID: { type: ["string", "null"] }, messageID: { type: ["string", "null"] },
  admission: { type: ["object", "null"], properties: { kind: { type: "string", const: "accepted" }, passageID: id, messageID: id,
    missionID: { type: "string" }, conversationID: { type: "string" } }, required: ["kind", "passageID", "messageID", "missionID", "conversationID"], additionalProperties: false },
}, required: ["scheduleID", "requestID", "expectedRevision", "version", "projectID", "projectCanonical", "location", "outcome", "passageID", "messageID", "admission"], additionalProperties: false } as const
