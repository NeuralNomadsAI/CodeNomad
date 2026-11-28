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
