import { createHmac } from "node:crypto"
import { canonicalAuthority } from "./authority-protocol"

export interface RecurrenceControlProofBody {
  scheduleID: string
  expectedRevision: number
  action: "play" | "pause" | "stop"
  profileSource: { profileID: string; executionHost: string; configYamlPath: string }
  issuedAt: number
}

/** Reuse the existing authenticated desktop bridge secret; never expose it in RPC. */
export function signNativeRecurrenceControl(input: RecurrenceControlProofBody, token: string): string {
  return createHmac("sha256", token).update(canonicalAuthority(input)).digest("hex")
}
