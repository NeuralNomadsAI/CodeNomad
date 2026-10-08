import { z } from "zod"
import { recurrenceIDSchema } from "./recurrence-contract"
import { recurrenceHumanRequestID } from "./recurrence-authority-contract"
import { lifecycleOperationReadSchema, lifecycleOperationSchema, nativeAcknowledgementSchema } from "./lifecycle-schema"

export const recurrenceNativeControlSchema = lifecycleOperationReadSchema.refine(value => value.action === "pause" || value.action === "stop")

export const recurrenceControlRequestSchema = z.object({ scheduleID: recurrenceIDSchema,
  requestID: recurrenceIDSchema, action: z.enum(["play", "pause", "stop"]),
  expectedRevision: z.number().int().nonnegative().safe(), expectedEpoch: z.number().int().nonnegative().safe(),
}).strict().refine(input => input.requestID === recurrenceHumanRequestID(input.scheduleID, input.expectedEpoch + 1,
  input.action === "play" ? "authorize" : input.action === "pause" ? "pause" : "revoke"), "Control request differs from its exact epoch/action")
export type RecurrenceControlRequest = z.infer<typeof recurrenceControlRequestSchema>
export const recurrenceControlHttpSchema = z.object({ scheduleID: recurrenceIDSchema,
  requestID: recurrenceIDSchema, action: z.enum(["play", "pause", "stop"]),
  expectedRevision: z.number().int().nonnegative().safe(), expectedEpoch: z.number().int().nonnegative().safe(),
  directory: z.string().min(1).max(4096).optional(),
  retry: z.boolean().optional(),
}).strict().refine(input => !(input.retry && input.action === "play")
  && recurrenceControlRequestSchema.safeParse((({ directory: _directory, retry: _retry, ...identity }) => identity)(input)).success,
  "Control request differs from its exact epoch/action")
export const recurrenceControlStatusSchema = z.object({ version: z.literal(1), scheduleID: recurrenceIDSchema,
  requestID: recurrenceIDSchema, expectedRevision: z.number().int().nonnegative().safe(),
  epoch: z.number().int().positive().safe(), outcome: z.enum(["committed", "unknown"]),
  state: z.enum(["running", "paused", "stopped"]).optional(), revision: z.number().int().nonnegative().safe().optional(),
  controlsComplete: z.boolean().optional(),
  schedulerCancellation: z.enum(["acknowledged", "unknown"]).optional(),
  nativeControl: recurrenceNativeControlSchema.optional(),
}).strict().refine(value => value.outcome !== "committed" || value.controlsComplete === true,
  "A committed control receipt requires positive completed native controls")
  .refine(value => !value.nativeControl || value.nativeControl.requestID === value.requestID,
    "Native target receipt belongs to another control request")
  .refine(value => value.controlsComplete !== true || !value.nativeControl?.pending.length && value.schedulerCancellation !== "unknown",
    "Unknown native targets/cancellation are not completed controls")
export type RecurrenceControlStatus = z.infer<typeof recurrenceControlStatusSchema>

const knownReceipt = lifecycleOperationSchema.properties.receipts.items.oneOf[0]
export const recurrenceNativeControlWire = { ...lifecycleOperationSchema, properties: {
  ...lifecycleOperationSchema.properties,
  action: { type: "string", enum: ["pause", "stop"] },
  targets: { ...lifecycleOperationSchema.properties.targets, maxItems: 32 },
  pending: { ...lifecycleOperationSchema.properties.pending, maxItems: 32 },
  receipts: { ...lifecycleOperationSchema.properties.receipts, maxItems: 32, items: { oneOf: [
    { ...knownReceipt, properties: { ...knownReceipt.properties, nativeAcknowledgement: { oneOf: nativeAcknowledgementSchema.oneOf.slice(1) } } },
    lifecycleOperationSchema.properties.receipts.items.oneOf[1],
  ] } },
} } as const
export const recurrenceControlRequestWire = { type: "object", properties: {
  scheduleID: { type: "string", minLength: 3, maxLength: 100, pattern: "^[A-Za-z0-9_-]{3,100}$" },
  requestID: { type: "string", minLength: 3, maxLength: 100, pattern: "^[A-Za-z0-9_-]{3,100}$" },
  action: { type: "string", enum: ["play", "pause", "stop"] },
  expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  expectedEpoch: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
}, required: ["scheduleID", "requestID", "action", "expectedRevision", "expectedEpoch"], additionalProperties: false } as const
