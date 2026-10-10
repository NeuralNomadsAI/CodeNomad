// RPC output uses OpenCode's supported JSON Schema subset. Native identity
// semantics remain checked by parseNativeBinding/parseNativeCallObservation.
export const nativeIdentitySchema = { type: "string", minLength: 1, maxLength: 240 } as const
const id = nativeIdentitySchema
const positive = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const
const source = { type: "object", properties: { id, sessionID: id, aggregateID: id, seq: positive, created: positive },
  required: ["id", "sessionID", "aggregateID", "seq", "created"], additionalProperties: false } as const
export const nativeLaunchModeSchema = { type: "string", enum: ["foreground", "background", "unknown"] } as const
const childOutcome = { type: "string", enum: ["started", "succeeded", "failed", "interrupted"] } as const

/** Observation wire shapes do not authenticate their native producer. */
export const nativeCallObservationSchema = { oneOf: [
  { type: "object", properties: { kind: { const: "tool-called" }, mode: nativeLaunchModeSchema, source },
    required: ["kind", "mode", "source"], additionalProperties: false },
  { type: "object", properties: { kind: { const: "tool-ended" }, mode: nativeLaunchModeSchema,
    outcome: { type: "string", enum: ["returned", "error"] }, source },
    required: ["kind", "mode", "outcome", "source"], additionalProperties: false },
  { type: "object", properties: { kind: { const: "child-uncorrelated" }, outcome: childOutcome, source },
    required: ["kind", "outcome", "source"], additionalProperties: false },
] } as const
export const nativeLaunchSchema = { type: "object", properties: { mode: nativeLaunchModeSchema,
  state: { type: "string", enum: ["called", "returned", "error"] } }, required: ["mode", "state"], additionalProperties: false } as const
export const nativeChildExecutionSchema = { type: "object", properties: { state: { const: "unknown" }, observedOutcome: childOutcome },
  required: ["state"], additionalProperties: false } as const
