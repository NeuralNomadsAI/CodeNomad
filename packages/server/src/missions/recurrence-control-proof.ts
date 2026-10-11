import { createHmac } from "node:crypto"
import { authorityDigest, canonicalAuthority } from "./authority-protocol"

export interface RecurrenceControlProofBody {
  sessionID: string
  workspaceID: string
  requestID: string
  location: { directory: string; workspaceID?: string }
  scheduleID: string
  expectedRevision: number
  action: "play" | "pause" | "stop" | "resume" | "run-now" | "check" | "create"
  configDigest?: string
  profileSource: { profileID: string; executionHost: string; configYamlPath: string }
  issuedAt: number
  digest: string
}

export function recurrenceControlRequestDigest(input: Omit<RecurrenceControlProofBody, "digest">): string {
  return authorityDigest(input)
}

const RECURRENCE_PROOF_LIFETIME_MS = 30_000

export function assertRecurrenceProofFresh(issuedAt: number, now = Date.now()): void {
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 5000 || now - issuedAt >= RECURRENCE_PROOF_LIFETIME_MS) {
    throw new Error("Recurrence proof expired")
  }
}

/** True only once the same clock makes every later `assertRecurrenceProofFresh`
 * of `issuedAt` fail. A future-dated issue time is not expired: it may become fresh. */
export function recurrenceProofExpired(issuedAt: number, now = Date.now()): boolean {
  return Number.isSafeInteger(issuedAt) && issuedAt >= 0 && now - issuedAt >= RECURRENCE_PROOF_LIFETIME_MS
}

/** Both the private bridge envelope and direct native RPC proof contain the
 * real cookie. Redact the whole payload without hiding native ses_ diagnostics. */
export function isRecurrenceProofPayload(value: Record<string, unknown>): boolean {
  return value.mode === "recurrence-control-verify"
    || typeof value.sessionID === "string" && typeof value.scheduleID === "string"
      && typeof value.digest === "string" && "profileSource" in value && "issuedAt" in value
}

/** Reuse the existing authenticated desktop bridge secret; never expose it in RPC. */
export function signNativeRecurrenceControl(input: RecurrenceControlProofBody, token: string): string {
  return createHmac("sha256", token).update(canonicalAuthority(input)).digest("hex")
}
