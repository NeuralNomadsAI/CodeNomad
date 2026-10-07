import type { AuthorityGrant } from "../authority-store"
import type { AuthorityIntent } from "../authority-protocol"
import { authorityDigest, canonicalAuthority, matchesAuthorityCompletion } from "../authority-protocol"
import type { AuthorityOperationResult } from "../authority-core"
import { deny, matchBinding, type HostDocument } from "./model"
import type { MissionLifecycleOperation } from "../lifecycle-model"

/** A protected mirror, NOT a second Mission journal/dispatcher. Native core owns
 * revision/epoch/receipt/capacity semantics; host owns denial and admission fences. */
export interface HostAuthorityRegistry {
  assertHostGrant(grant: AuthorityGrant): Promise<void>
  assertHostGrantCurrent(grant: AuthorityGrant): true
}
export interface NativeMirrorObservation {
  operation: AuthorityOperationResult
  revision: number
  terminal: "stopped" | "deleted" | null
  pendingRequestIDs: readonly string[]
}
/** Must read through authenticated native transport and verify namespace,
 * full binding, physical actors, connection/incarnation and original receipt.
 * The route/plugin owner supplies this; native state JSON alone is not a proof. */
export interface NativeAuthorityMirrorReader {
  read(body: AuthorityIntent): Promise<NativeMirrorObservation>
  /** Authenticated read-only restart reconciliation; never adoption or Play.
   * Optional implementations fail closed rather than borrowing human admission. */
  restore?(grant: AuthorityGrant, signal: AbortSignal): Promise<NativeGrantObservation>
}
export interface NativeGrantObservation {
  grant: AuthorityGrant | null
  revision: number
  terminal: "stopped" | "deleted" | null
  pendingRequestIDs: readonly string[]
  status: "active" | "completed" | "failed" | "stopped"
  runState: "prepared" | "running" | "paused" | "stopped"
  controlPending: boolean
  control: Pick<MissionLifecycleOperation, "id" | "missionID" | "requestID" | "action" | "expectedRevision" | "targets" | "pending" | "completedRevision">
}

export function stageMirror(doc: HostDocument, body: AuthorityIntent): void {
  matchBinding(body, doc.manifest)
  const denial = body.method === "revoke" || body.method === "delete" || body.method === "lifecycle" && body.payload.action === "stop"
  if (doc.pending && !denial) deny("native-operation-pending")
  if (doc.mirror) {
    matchBinding(doc.mirror.grant, body)
    // Adoption uses the NEXT signed epoch, all other intents use its original
    // current epoch. Never rewrite a signed body's epoch from a newer mirror.
    if (body.epoch !== doc.mirror.grant.epoch + (body.method === "adopt" ? 1 : 0)) deny("epoch-conflict")
    if (doc.mirror.grant.state !== "active" && !denial) deny("grant-revoked")
  } else {
    const ungranted = doc.epochFloor === 0 && body.epoch === 0
    if (body.method === "adopt" ? body.epoch !== doc.epochFloor + 1
      : !ungranted || body.method !== "create" && !denial) deny("missing-host-grant")
  }
  if (doc.revoked && !denial) deny("signer-revoked")
  if (doc.mirror && ["lifecycle", "revoke", "delete"].includes(body.method)) {
    doc.mirror.disabled = true
    doc.mirror.grant.sendsEnabled = false
    if (denial) doc.mirror.grant.state = "revoked"
  }
  doc.pending = { body, digest: authorityDigest(body) }
}

export function acceptMirror(doc: HostDocument, native: NativeMirrorObservation): void {
  const pending = doc.pending
  if (!pending) deny("no-host-reservation")
  const { receipt, grant } = native.operation
  const denial = pending.body.method === "revoke" || pending.body.method === "delete"
    || pending.body.method === "lifecycle" && pending.body.payload.action === "stop"
  if (receipt.requestID !== pending.body.requestID || receipt.digest !== pending.digest
    || authorityDigest(receipt.intent) !== pending.digest || receipt.signerDigest !== doc.signerDigest
    || receipt.provisioningGeneration !== doc.generation || !receipt.completion || receipt.completion.outcome !== "applied"
    || !matchesAuthorityCompletion(pending.body, receipt.completion)
    || native.pendingRequestIDs.includes(pending.body.requestID) || !denial && native.pendingRequestIDs.length
    || !Number.isSafeInteger(native.revision) || native.revision < pending.body.expectedRevision) deny("native-receipt-mismatch")
  if (pending.body.method === "delete" && native.terminal !== "deleted"
    || pending.body.method === "lifecycle" && pending.body.payload.action === "stop" && native.terminal !== "stopped") deny("terminal-denial-missing")
  if (grant) {
    matchBinding(grant, pending.body)
    if (grant.epoch !== pending.body.epoch || grant.signerDigest !== doc.signerDigest) deny("native-mirror-mismatch")
    if (denial && (grant.state !== "revoked" || grant.sendsEnabled)) deny("denial-not-published")
    if (doc.mirror?.grant.state === "revoked" && grant.state !== "revoked") deny("denial-monotonicity")
    doc.mirror = { grant: JSON.parse(canonicalAuthority(grant)), nativeRevision: native.revision,
      disabled: doc.revoked || Boolean(native.terminal) || !grant.sendsEnabled || grant.state !== "active" }
  } else if (doc.mirror || doc.epochFloor !== 0 || pending.body.epoch !== 0
    || pending.body.method !== "create" && !denial) deny("native-mirror-missing")
  doc.pending = null
}
export function assertMirror(doc: HostDocument, grant: AuthorityGrant): true {
  matchBinding(grant, doc.manifest)
  if (doc.revoked || doc.pending || !doc.anchor || !doc.mirror || doc.mirror.disabled
    || grant.state !== "active" || !grant.sendsEnabled || canonicalAuthority(doc.mirror.grant) !== canonicalAuthority(grant)) deny("host-grant-disabled")
  return true
}
