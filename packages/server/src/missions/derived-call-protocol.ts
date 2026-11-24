import { createPublicKey, verify, type KeyObject } from "node:crypto"
import { z } from "zod"
import { authorityBindingSchema, authorityDigest, authorityRootSchema, authoritySignerDigest,
  assertAuthorityScope, canonicalAuthority, rejectAuthority, MISSION_AUTHORITY_POLICY, type AuthoritySignerSnapshot } from "./authority-protocol"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { matchesExecution } from "./execution"

export const DERIVED_CALL_POLICY = "codenomad.missions.native-call/signed-v1" as const
const id = z.string().min(1).max(240).regex(/^[^\s\x00-\x1f\x7f]+$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const generation = z.number().int().positive().safe()
export const derivedTaskReferenceSchema = z.object({ taskKey: id, generation }).strict()
export const derivedExecutionSchema = z.object({
  agent: id.optional(), model: z.object({ providerID: id, id, variant: id.optional() }).strict().optional(),
}).strict()
export const derivedCallBodySchema = authorityBindingSchema.extend({
  version: z.literal(1), policy: z.literal(DERIVED_CALL_POLICY), epoch: generation,
  provisioningGeneration: id, signerDigest: digest,
  reservationID: z.string().regex(/^dcall_[a-f0-9]{48}$/),
  task: derivedTaskReferenceSchema, taskContractDigest: digest,
  // The parent's OWN generation; never substitute the child's generation.
  parentTask: derivedTaskReferenceSchema.nullable(),
  parentSessionID: id, parentMessageID: id, toolCallID: id,
  choice: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("new") }).strict(),
    z.object({ kind: z.literal("continue"), sessionID: id }).strict(),
    z.object({ kind: z.literal("reuse"), sessionID: id, fromTask: derivedTaskReferenceSchema }).strict(),
  ]),
  execution: derivedExecutionSchema, root: authorityRootSchema,
}).strict().superRefine((body, ctx) => {
  if (!body.roots.some(root => canonicalAuthority(root) === canonicalAuthority(body.root))
    || body.parentTask?.taskKey === body.task.taskKey
    || body.choice.kind !== "new" && body.choice.sessionID === body.parentSessionID
    || body.choice.kind === "reuse" && body.choice.fromTask.taskKey === body.task.taskKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid derived call scope" })
  }
})
export type DerivedCallBody = z.infer<typeof derivedCallBodySchema>
export const signedDerivedCallSchema = z.object({ body: derivedCallBodySchema,
  signature: z.string().length(88).regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict()
export type SignedDerivedCall = z.infer<typeof signedDerivedCallSchema>
export type DerivedTaskReference = z.infer<typeof derivedTaskReferenceSchema>
export type DerivedExecution = z.infer<typeof derivedExecutionSchema>

/** Deterministic invocation reservation, not a caller-selected retry key. */
export function derivedReservationID(body: Omit<DerivedCallBody, "reservationID">): string {
  return `dcall_${authorityDigest(body).slice(0, 48)}`
}
export function parseDerivedCallBody(input: unknown): DerivedCallBody {
  canonicalAuthority(input)
  const parsed = derivedCallBodySchema.safeParse(input)
  if (!parsed.success) rejectAuthority("invalid-intent")
  const { reservationID, ...identity } = parsed.data
  if (reservationID !== derivedReservationID(identity)) rejectAuthority("request-conflict")
  return parsed.data
}
export function derivedSigningBytes(body: DerivedCallBody): Buffer {
  return Buffer.from(`${DERIVED_CALL_POLICY}\n${canonicalAuthority(body)}`)
}
export function authenticateDerivedCall(input: unknown, signer: AuthoritySignerSnapshot): SignedDerivedCall {
  canonicalAuthority(input)
  const parsed = signedDerivedCallSchema.safeParse(input)
  if (!parsed.success) rejectAuthority("invalid-intent")
  const body = parseDerivedCallBody(parsed.data.body)
  assertAuthorityScope(body, { ...signer, roots: signer.roots.map(root => ({ ...root })) })
  if (body.provisioningGeneration !== signer.provisioningGeneration || body.signerDigest !== signer.signerDigest
    || signer.qualification !== "qualified" || signer.policy !== MISSION_AUTHORITY_POLICY) rejectAuthority("untrusted-signer")
  verifyDerivedSignature(parsed.data, signer.publicKey)
  return { body, signature: parsed.data.signature }
}
function verifyDerivedSignature(signed: SignedDerivedCall, publicKey: KeyObject): void {
  const bytes = Buffer.from(signed.signature, "base64")
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519"
    || bytes.toString("base64") !== signed.signature || !verify(null, derivedSigningBytes(signed.body), publicKey, bytes)) {
    rejectAuthority("untrusted-signer")
  }
}

export const derivedChildBindingSchema = z.object({ sessionID: id, parentSessionID: id,
  root: authorityRootSchema, execution: derivedExecutionSchema,
  projectID: id.optional(),
  location: z.object({ directory: z.string().min(1).max(4096), workspaceID: id.optional() }).strict().optional(),
}).strict()
export type DerivedChildBinding = z.infer<typeof derivedChildBindingSchema>
export const derivedCallRecordSchema = z.object({
  signed: signedDerivedCallSchema, digest, publicKey: z.string().min(1).max(1024),
  state: z.enum(["reserved", "invoking", "active", "ended"]),
  child: derivedChildBindingSchema.optional(),
  ended: z.enum(["returned", "error"]).optional(),
}).strict().superRefine((record, ctx) => {
  try { assertDerivedRecord(record) }
  catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid derived call evidence" }) }
})
export type DerivedCallRecord = {
  signed: SignedDerivedCall; digest: string; publicKey: string
  state: "reserved" | "invoking" | "active" | "ended"; child?: DerivedChildBinding; ended?: "returned" | "error"
}
/** Integrity only: a self-contained key/signature is NEVER host authorization. */
export function assertDerivedRecord(record: DerivedCallRecord): void {
  const body = parseDerivedCallBody(record.signed.body)
  if (record.digest !== authorityDigest(body) || (record.state === "reserved" || record.state === "invoking") !== (record.child === undefined)
    || (record.state === "ended") !== (record.ended !== undefined)) rejectAuthority("storage-invalid")
  let key: KeyObject
  try { key = createPublicKey({ key: Buffer.from(record.publicKey, "base64"), format: "der", type: "spki" }) }
  catch { return rejectAuthority("storage-invalid") }
  if (key.export({ format: "der", type: "spki" }).toString("base64") !== record.publicKey
    || authoritySignerDigest(key) !== body.signerDigest) rejectAuthority("storage-invalid")
  verifyDerivedSignature(record.signed, key)
  if (record.child && (record.child.parentSessionID !== body.parentSessionID
    || record.child.sessionID === body.parentSessionID || canonicalAuthority(record.child.root) !== canonicalAuthority(body.root)
    || body.choice.kind !== "new" && body.choice.sessionID !== record.child.sessionID
    || record.child.projectID !== undefined && record.child.projectID !== body.projectID
    || !matchesExecution(body.execution, record.child.execution))) rejectAuthority("storage-invalid")
}

export type DerivedInvocationPurpose = "reserve" | "bind" | "execute" | "report" | "end"
/** Mandatory trusted construction dependency from a genuine managed-writer
 * channel. Authenticate the ACTUAL invocation/caller/child and sustained writer,
 * physical-family/connection/lifecycle facts, not JSON/HMAC/process-only proof.
 * report/end may attest admitted historical evidence without granting new sends.
 * No producer, permissive default, RPC caller identity or proof issuer exists here. */
export interface DerivedInvocationVerifier {
  verify(input: DerivedInvocationInput): Promise<DerivedInvocationLease>
}
export interface DerivedInvocationInput {
  body: Readonly<DerivedCallBody>; purpose: DerivedInvocationPurpose
  childSessionID?: string; outcome?: "returned" | "error"; proof: unknown; signal: AbortSignal
}
export interface DerivedInvocationLease {
  readonly bodyDigest: string
  readonly purpose: DerivedInvocationPurpose
  readonly callerSessionID: string
  readonly childSessionID?: string
  readonly outcome?: "returned" | "error"
  assertCurrent(): true
}
export function assertDerivedInvocation(lease: DerivedInvocationLease, body: DerivedCallBody,
  purpose: DerivedInvocationPurpose, childSessionID?: string, outcome?: "returned" | "error"): true {
  if (!lease || lease.bodyDigest !== authorityDigest(body) || lease.purpose !== purpose
    || lease.childSessionID !== childSessionID || lease.outcome !== outcome
    || lease.callerSessionID !== (purpose === "execute" || purpose === "report" ? childSessionID : body.parentSessionID)) {
    rejectAuthority("binding-mismatch")
  }
  return assertSynchronousAuthorityGuard(() => lease.assertCurrent(), "policy-unqualified")
}

// Ephemeral verification provenance, NOT native attestation or durable authority.
// Prevent the internal host signer from accepting a raw caller-made lease. Only
// the explicitly supplied genuine verifier can admit one; no built-in issuer or
// permissive production verifier exists. Structural tests inject their own trust.
const verifiedInvocations = new WeakSet<DerivedInvocationLease>()
export async function verifyDerivedInvocation(verifier: DerivedInvocationVerifier | undefined,
  input: DerivedInvocationInput): Promise<DerivedInvocationLease> {
  input.signal.throwIfAborted()
  if (!verifier || input.proof === undefined || input.proof === null) rejectAuthority("policy-unqualified")
  let raw: DerivedInvocationLease
  try { raw = await verifier.verify(input) }
  catch { return rejectAuthority("policy-unqualified") }
  assertDerivedInvocation(raw, input.body, input.purpose, input.childSessionID, input.outcome)
  input.signal.throwIfAborted()
  const lease = Object.freeze({ bodyDigest: raw.bodyDigest, purpose: raw.purpose, callerSessionID: raw.callerSessionID,
    childSessionID: raw.childSessionID, outcome: raw.outcome, assertCurrent: raw.assertCurrent.bind(raw) })
  assertDerivedInvocation(lease, input.body, input.purpose, input.childSessionID, input.outcome)
  verifiedInvocations.add(lease)
  return lease
}
export function assertVerifiedDerivedInvocation(lease: DerivedInvocationLease, body: DerivedCallBody,
  purpose: DerivedInvocationPurpose, childSessionID?: string, outcome?: "returned" | "error"): true {
  if (!verifiedInvocations.has(lease)) rejectAuthority("policy-unqualified")
  return assertDerivedInvocation(lease, body, purpose, childSessionID, outcome)
}
