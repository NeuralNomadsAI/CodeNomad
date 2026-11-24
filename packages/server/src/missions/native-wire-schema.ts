import { nativeIdentitySchema as nativeID, nativeCallObservationSchema, nativeLaunchSchema, nativeChildExecutionSchema } from "./native-observation-wire-schema"

const key = { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,63}$" } as const

export const taskExecutionModeSchema = {
  oneOf: [
    { type: "object", properties: { kind: { type: "string", const: "native" },
      parentTaskKey: { anyOf: [key, { type: "null" }] }, reuseFromTaskKey: key },
    required: ["kind", "parentTaskKey"], additionalProperties: false },
    { type: "object", properties: { kind: { type: "string", const: "independent" },
      reason: { type: "string", enum: ["location", "lifetime", "existing-root", "playbook"] },
      explanation: { type: "string", minLength: 1, maxLength: 2_000, pattern: "\\S" } },
    required: ["kind", "reason", "explanation"], additionalProperties: false },
  ],
} as const

// Model-facing inputs keep patterns; native RPC output cannot decode them.
// The journal's parseExecutionMode still validates keys and nonblank reasons.
const rpcKey = { type: "string", minLength: 2, maxLength: 64 } as const
export const taskExecutionModeRpcSchema = { oneOf: [
  { ...taskExecutionModeSchema.oneOf[0], properties: { ...taskExecutionModeSchema.oneOf[0].properties,
    parentTaskKey: { anyOf: [rpcKey, { type: "null" }] }, reuseFromTaskKey: rpcKey } },
  { ...taskExecutionModeSchema.oneOf[1], properties: { ...taskExecutionModeSchema.oneOf[1].properties,
    explanation: { type: "string", minLength: 1, maxLength: 2_000 } } },
] } as const

export const taskGenerationSchema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const
export const taskContractReferenceWireSchema = {
  type: "object", properties: { missionID: { type: "string", pattern: "^[A-Za-z0-9_-]{3,100}$" }, taskKey: key,
    generation: taskGenerationSchema }, required: ["missionID", "taskKey", "generation"], additionalProperties: false,
} as const
export const nativeCallBindingSchema = {
  type: "object", properties: { generation: taskGenerationSchema,
    parentSessionID: nativeID, toolCallID: nativeID, parentMessageID: nativeID },
  required: ["generation", "parentSessionID", "toolCallID", "parentMessageID"], additionalProperties: false,
} as const

export const nativeTaskBindingSchema = {
  ...nativeCallBindingSchema,
  properties: { ...nativeCallBindingSchema.properties, nativeReturned: { type: "boolean", const: true } },
} as const

export const nativeTaskExecutionSchema = {
  type: "object", properties: { binding: nativeCallBindingSchema, ended: { type: "string", enum: ["returned", "error"] },
    launch: nativeLaunchSchema, childExecution: nativeChildExecutionSchema,
    observations: { type: "array", maxItems: 2000, items: nativeCallObservationSchema }, observationConflict: { type: "boolean", const: true } },
  required: ["binding"], additionalProperties: false,
} as const
