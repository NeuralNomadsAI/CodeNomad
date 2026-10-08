import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import type { MissionAction, MissionLifecycleInput, MissionNativeAcknowledgement, MissionLifecycleOperation } from "./lifecycle-model"
import { controlResumeAdmissionID, recurrenceMessageID } from "./receipt-identity"
import { MISSION_LIFECYCLE_TEXT_LIMIT } from "./lifecycle-input"

const id = z.string().min(1).max(240)
const identity = { missionID: id, operationID: id, sessionID: id }
const recurrence = z.object({ grantID: id, passageID: id, messageID: id, coordinatorSessionID: id }).strict()
const cancellation = z.object({ inboxID: id, disposition: z.enum(["native-acknowledged", "observed-absent"]) }).strict()
const interruptAcknowledgement = z.object({ ...identity, action: z.enum(["pause", "stop"]),
  disposition: z.literal("interrupt-observed"), interrupt: z.object({ interrupted: z.boolean() }).strict(),
  cancellations: z.array(cancellation).max(128) }).strict()
const startAcknowledgement = z.object({ ...identity, action: z.literal("start"), disposition: z.literal("start-admitted"),
  admission: z.object({ id, sessionID: id, type: z.literal("synthetic"), delivery: z.literal("queue"),
    time: z.object({ created: z.number().finite().nonnegative() }).strict(),
    payload: z.object({ text: z.string().min(1).max(MISSION_LIFECYCLE_TEXT_LIMIT), description: z.string().max(1_024).optional(),
      metadata: z.record(z.unknown()).refine(boundedJson).optional() }).strict(),
  }).strict() }).strict()
const acknowledgement = z.union([startAcknowledgement, interruptAcknowledgement,
  z.object({ ...identity, action: z.enum(["pause", "stop"]), disposition: z.literal("target-missing") }).strict()])

/** Strict known evidence only. Historical absence stays absent; never coerce an
 * old {applied:true}, void, unknown response or activity observation into an ACK. */
export function parseMissionNativeAcknowledgement(value: unknown, expected?: {
  missionID: string; operationID: string; sessionID: string; action: MissionAction
  recurrence?: MissionLifecycleInput["recurrence"]
}): MissionNativeAcknowledgement | undefined {
  const parsed = acknowledgement.safeParse(value)
  if (!parsed.success) return undefined
  const ack = parsed.data
  if (expected && (ack.missionID !== expected.missionID || ack.operationID !== expected.operationID
    || ack.sessionID !== expected.sessionID || ack.action !== expected.action)) return undefined
  if (ack.disposition === "start-admitted") {
    const metadata = ack.admission.payload.metadata?.["codenomad.mission"]
    const claimed = metadata !== null && metadata !== undefined && typeof metadata === "object" && !Array.isArray(metadata)
      ? recurrence.safeParse((metadata as Record<string, unknown>).recurrence) : { success: false as const }
    const bound = claimed.success ? claimed.data : undefined
    const wrongID = bound ? bound.messageID !== recurrenceMessageID(bound.passageID)
        || bound.coordinatorSessionID !== ack.sessionID || ack.admission.id !== bound.messageID
      : ack.admission.id !== controlResumeAdmissionID(ack.operationID, ack.sessionID)
    if (wrongID || expected && (Boolean(bound) !== Boolean(expected.recurrence)
        || bound && !isDeepStrictEqual(bound, expected.recurrence))
      || metadata && typeof metadata === "object" && !Array.isArray(metadata)
        && "recurrence" in metadata && !bound
      || ack.admission.sessionID !== ack.sessionID
      || !metadata || typeof metadata !== "object" || Array.isArray(metadata)
      || (metadata as Record<string, unknown>).version !== 1 || (metadata as Record<string, unknown>).kind !== "lifecycle"
      || (metadata as Record<string, unknown>).missionID !== ack.missionID
      || (metadata as Record<string, unknown>).operationID !== ack.operationID) return undefined
  }
  if (ack.disposition === "interrupt-observed" && (ack.action === "pause" && ack.cancellations.length
    || new Set(ack.cancellations.map(item => item.inboxID)).size !== ack.cancellations.length)) return undefined
  return ack as MissionNativeAcknowledgement
}

export function parseMissionLifecycleReply(value: unknown, expected: Parameters<typeof parseMissionNativeAcknowledgement>[1]): MissionNativeAcknowledgement | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1
    || !("nativeAcknowledgement" in value)) return undefined
  return parseMissionNativeAcknowledgement(value.nativeAcknowledgement, expected)
}

/** Bounded strict lifecycle receipt projection for native recurrence snapshots. */
export const lifecycleOperationReadSchema = z.object({ id, missionID: id, requestID: id,
  expectedRevision: z.number().int().positive().safe(), action: z.enum(["start", "pause", "stop"]),
  recurrence: recurrence.optional(), completedRevision: z.number().int().positive().safe().optional(),
  targets: z.array(z.object({ sessionID: id, location: z.object({ directory: z.string().min(1).max(4096), workspaceID: id.optional() }).strict() }).strict()).max(32),
  pending: z.array(id).max(32),
  receipts: z.array(z.union([
    z.object({ receiptID: id, sessionID: id, acknowledgementState: z.literal("known"), nativeAcknowledgement: acknowledgement }).strict(),
    z.object({ receiptID: id, sessionID: id, acknowledgementState: z.literal("unknown") }).strict(),
  ])).max(32).optional(),
}).strict().refine(value => new Set(value.targets.map(target => target.sessionID)).size === value.targets.length
  && new Set(value.pending).size === value.pending.length && value.pending.every(session => value.targets.some(target => target.sessionID === session))
  && new Set(value.receipts?.map(receipt => receipt.sessionID)).size === (value.receipts?.length ?? 0)
  && (value.receipts ?? []).every(receipt => value.targets.some(target => target.sessionID === receipt.sessionID)
    && (receipt.acknowledgementState === "unknown" ? value.pending.includes(receipt.sessionID)
      : !value.pending.includes(receipt.sessionID) && !!parseMissionNativeAcknowledgement(receipt.nativeAcknowledgement,
        { missionID: value.missionID, operationID: value.id, sessionID: receipt.sessionID, action: value.action, recurrence: value.recurrence }))))
  .transform(value => value as MissionLifecycleOperation)

function boundedJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }]
  let nodes = 0, bytes = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++nodes > 512 || item.depth > 16) return false
    const entry = item.value
    if (entry === null || typeof entry === "boolean") continue
    if (typeof entry === "number") { if (!Number.isFinite(entry)) return false; continue }
    if (typeof entry === "string") { bytes += entry.length; if (bytes > 16_384) return false; continue }
    if (typeof entry !== "object") return false
    if (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype) return false
    for (const [key, child] of Object.entries(entry)) {
      bytes += key.length
      if (bytes > 16_384) return false
      pending.push({ value: child, depth: item.depth + 1 })
    }
  }
  return true
}

export const lifecycleInputSchema = {
  type: "object", properties: {
    missionID: { type: "string", minLength: 1, maxLength: 100 }, requestID: { type: "string", minLength: 1, maxLength: 128 },
    expectedRevision: { type: "integer", minimum: 1 }, action: { type: "string", enum: ["start", "pause", "stop"] },
  }, required: ["missionID", "requestID", "expectedRevision", "action"], additionalProperties: false,
} as const
const ackIdentityProperties = { missionID: { type: "string", minLength: 1, maxLength: 240 },
  operationID: { type: "string", minLength: 1, maxLength: 240 }, sessionID: { type: "string", minLength: 1, maxLength: 240 } } as const
const ackIdentityRequired = ["missionID", "operationID", "sessionID", "action", "disposition"] as const
export const nativeAcknowledgementSchema = { oneOf: [
  { type: "object", properties: { ...ackIdentityProperties, action: { const: "start" }, disposition: { const: "start-admitted" },
    admission: { type: "object", properties: { id: ackIdentityProperties.sessionID, sessionID: ackIdentityProperties.sessionID,
      type: { const: "synthetic" }, delivery: { const: "queue" }, time: { type: "object", properties: { created: { type: "number", minimum: 0 } }, required: ["created"], additionalProperties: false },
      payload: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: MISSION_LIFECYCLE_TEXT_LIMIT },
        description: { type: "string", maxLength: 1_024 }, metadata: { type: "object" } }, required: ["text", "metadata"], additionalProperties: false },
    }, required: ["id", "sessionID", "type", "delivery", "time", "payload"], additionalProperties: false },
  }, required: [...ackIdentityRequired, "admission"], additionalProperties: false },
  { type: "object", properties: { ...ackIdentityProperties, action: { enum: ["pause", "stop"] }, disposition: { const: "interrupt-observed" },
    interrupt: { type: "object", properties: { interrupted: { type: "boolean" } }, required: ["interrupted"], additionalProperties: false },
    cancellations: { type: "array", maxItems: 128, items: { type: "object", properties: { inboxID: ackIdentityProperties.sessionID,
      disposition: { enum: ["native-acknowledged", "observed-absent"] } }, required: ["inboxID", "disposition"], additionalProperties: false } },
  }, required: [...ackIdentityRequired, "interrupt", "cancellations"], additionalProperties: false },
  { type: "object", properties: { ...ackIdentityProperties, action: { enum: ["pause", "stop"] }, disposition: { const: "target-missing" } },
    required: ackIdentityRequired, additionalProperties: false },
] } as const
export const lifecycleOperationSchema = {
  type: "object", properties: {
    ...lifecycleInputSchema.properties, recurrence: { type: "object", properties: {
      grantID: { type: "string" }, passageID: { type: "string" }, messageID: { type: "string" }, coordinatorSessionID: { type: "string" },
    }, required: ["grantID", "passageID", "messageID", "coordinatorSessionID"], additionalProperties: false },
    id: { type: "string" }, pending: { type: "array", items: { type: "string" } },
    completedRevision: { type: "integer", minimum: 1 },
    // Native V2's JSON Schema decoder does not support `not`. Complete,
    // disjoint object branches retain the exact known/unknown evidence rule.
    receipts: { type: "array", maxItems: 8, items: { oneOf: [
      { type: "object", properties: { receiptID: { type: "string" }, sessionID: { type: "string" },
        acknowledgementState: { const: "known" }, nativeAcknowledgement: nativeAcknowledgementSchema },
        required: ["receiptID", "sessionID", "acknowledgementState", "nativeAcknowledgement"], additionalProperties: false },
      { type: "object", properties: { receiptID: { type: "string" }, sessionID: { type: "string" },
        acknowledgementState: { const: "unknown" } },
        required: ["receiptID", "sessionID", "acknowledgementState"], additionalProperties: false },
    ] } },
    targets: { type: "array", items: {
      type: "object", properties: { sessionID: { type: "string" }, location: {
        type: "object", properties: { directory: { type: "string" }, workspaceID: { type: "string" } }, required: ["directory"], additionalProperties: false,
      } }, required: ["sessionID", "location"], additionalProperties: false,
    } },
  }, required: [...lifecycleInputSchema.required, "id", "pending", "targets"], additionalProperties: false,
} as const
