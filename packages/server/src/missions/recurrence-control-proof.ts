import { createHmac } from "node:crypto"
import { z } from "zod"
import { canonicalAuthority } from "./authority-protocol"
import { preparationAuthorSchema, type PreparationAuthor } from "./preparation-input"

export type SchedulePrincipal = { kind: "human"; sessionID: string }
  | { kind: "agent"; author: PreparationAuthor; creationRequestID?: string; creationDigest?: string }

const sessionID = z.string().min(1).max(256)
export const schedulePrincipalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), sessionID }).strict(),
  z.object({ kind: z.literal("agent"), author: preparationAuthorSchema,
    creationRequestID: z.string().min(1).max(128).optional(), creationDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
      .refine(value => (value.creationRequestID === undefined) === (value.creationDigest === undefined)),
])
// Native wire supports bounded strings; the domain schema validates their format.
export const schedulePrincipalWire = { oneOf: [
  { type: "object", properties: { kind: { const: "human" }, sessionID: { type: "string", minLength: 1, maxLength: 256 } },
    required: ["kind", "sessionID"], additionalProperties: false },
  { type: "object", properties: { kind: { const: "agent" },
    author: { type: "object", properties: { coordinatorSessionID: { type: "string", minLength: 1, maxLength: 240 },
      missionID: { type: "string", minLength: 3, maxLength: 100 } }, required: ["coordinatorSessionID"], additionalProperties: false },
    creationRequestID: { type: "string", minLength: 1, maxLength: 128 },
    creationDigest: { type: "string", minLength: 64, maxLength: 64 } },
    required: ["kind", "author"], additionalProperties: false },
] } as const
type PrincipalIdentity = { sessionID: string; principal?: never } | { principal: SchedulePrincipal; sessionID?: never }
interface RecurrenceControlProofFields {
  workspaceID: string
  requestID: string
  location: { directory: string; workspaceID?: string }
  scheduleID: string
  expectedRevision: number
  action: "play" | "pause" | "stop" | "resume" | "run-now" | "check" | "create" | "configure" | "delete"
  configDigest?: string
  profileSource: { profileID: string; executionHost: string; configYamlPath: string }
  issuedAt: number
  digest: string
}
export type RecurrenceControlProofBody = RecurrenceControlProofFields & PrincipalIdentity
const proofFields = { workspaceID: z.string().min(1).max(200), requestID: z.string().min(1).max(128),
  location: z.object({ directory: z.string().min(1).max(4096), workspaceID: z.string().optional() }).strict(),
  scheduleID: z.string().regex(/^[A-Za-z0-9_-]{3,100}$/), expectedRevision: z.number().int().nonnegative().safe(),
  action: z.enum(["play", "pause", "stop", "resume", "run-now", "check", "create", "configure", "delete"]),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  profileSource: z.object({ profileID: z.string().min(1).max(240), executionHost: z.string().min(1).max(240),
    configYamlPath: z.string().min(1).max(4096) }).strict(),
  issuedAt: z.number().int().nonnegative().safe(), digest: z.string().regex(/^[a-f0-9]{64}$/),
}
/** The sessionID-only format explicitly names a human; never infer an agent from it. */
export const recurrenceControlProofSchema = z.union([
  z.object({ ...proofFields, sessionID, principal: z.never().optional() }).strict(),
  z.object({ ...proofFields, principal: schedulePrincipalSchema, sessionID: z.never().optional() }).strict(),
])
export function recurrenceSchedulePrincipal(input: Pick<RecurrenceControlProofBody, "sessionID" | "principal">): SchedulePrincipal {
  if (input.principal !== undefined && input.sessionID === undefined) return schedulePrincipalSchema.parse(input.principal)
  if (input.principal === undefined && typeof input.sessionID === "string") return { kind: "human", sessionID: sessionID.parse(input.sessionID) }
  throw new Error("Recurrence principal differs")
}

const RECURRENCE_PROOF_LIFETIME_MS = 30_000

export function assertRecurrenceProofFresh(issuedAt: number, now = Date.now()): void {
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 5000 || now - issuedAt >= RECURRENCE_PROOF_LIFETIME_MS) {
    throw new Error("Recurrence proof expired")
  }
}

/** Redact signed principals and private bridge payloads while retaining native ses_ diagnostics. */
export function isRecurrenceProofPayload(value: Record<string, unknown>): boolean {
  return value.mode === "recurrence-control-verify"
    || "principal" in value && "proof" in value && "command" in value && "issuedAt" in value
    || (typeof value.sessionID === "string" || "principal" in value) && typeof value.scheduleID === "string"
      && typeof value.digest === "string" && "profileSource" in value && "issuedAt" in value
}

/** Reuse the existing authenticated desktop bridge secret; never expose it in RPC. */
export function signNativeRecurrenceControl(input: RecurrenceControlProofBody, token: string): string {
  return createHmac("sha256", token).update(canonicalAuthority(input)).digest("hex")
}
