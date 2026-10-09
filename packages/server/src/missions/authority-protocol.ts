import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto"
import { z } from "zod"
import { controlOperationID } from "./receipt-identity"
import type { MissionLifecycleOperation } from "./lifecycle-model"
import { missionProfilesInputSchema } from "./playbook-profiles"
import { missionTaskModeInputSchema } from "./task-execution-mode"
import { MISSION_TITLE_MAX, MISSION_TITLE_PATTERN } from "./mission-title"

export const MISSION_AUTHORITY_POLICY = "codenomad.missions.authority/signed-v1"
export const AUTHORITY_MAX_BYTES = 128 * 1024
export const AUTHORITY_METHODS = ["create", "update", "delete", "lifecycle", "recover", "adopt", "revoke"] as const
export const AUTHORITY_ID_MAX_LENGTH = 240
export const AUTHORITY_REQUEST_MAX_LENGTH = 128
const id = z.string().min(1).max(AUTHORITY_ID_MAX_LENGTH)
const requestID = z.string().min(1).max(AUTHORITY_REQUEST_MAX_LENGTH)
const revision = z.number().int().nonnegative().safe()

// Physical identities are supplied by the ownership adapter, never inferred from
// a path prefix or projectID. executionHost includes the selected WSL distro.
export const authorityRootSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("git"), directory: z.string().min(1).max(4096), family: id, checkout: id }).strict(),
  z.object({ mode: z.literal("directory-only"), directory: z.string().min(1).max(4096) }).strict(),
])
export const authorityBindingSchema = z.object({
  authorityID: id, keyID: id, profileID: id, executionHost: id,
  namespace: z.string().uuid(), projectID: id, projectCanonical: z.string().min(1).max(4096),
  roots: z.array(authorityRootSchema).min(1).max(32), missionID: id, coordinatorSessionID: id,
}).strict()

const header = authorityBindingSchema.extend({
  version: z.literal(1), policy: z.literal(MISSION_AUTHORITY_POLICY),
  epoch: revision, expectedRevision: revision, requestID,
})
export const authorityIntentSchema = z.discriminatedUnion("method", [
  header.extend({ method: z.literal("create"), payload: z.object({
    objective: z.string().min(1).max(20_000), notes: z.string().max(20_000).optional(),
    title: z.string().trim().min(1).max(MISSION_TITLE_MAX).regex(MISSION_TITLE_PATTERN).optional(),
    template: z.enum(["custom", "pocock-fix-bug", "wayfinder"]), prepared: z.literal(true),
    profiles: missionProfilesInputSchema,
    taskMode: missionTaskModeInputSchema.optional(),
  }).strict() }).strict(),
  header.extend({ method: z.literal("update"), payload: z.object({
    objective: z.string().min(1).max(20_000), notes: z.string().max(20_000).optional(),
  }).strict() }).strict(),
  header.extend({ method: z.literal("delete"), payload: z.object({ deleteManagedSessions: z.boolean() }).strict() }).strict(),
  header.extend({ method: z.literal("lifecycle"), payload: z.object({ action: z.enum(["start", "pause", "stop"]) }).strict() }).strict(),
  header.extend({ method: z.literal("recover"), payload: z.discriminatedUnion("target", [
    z.object({ target: z.literal("coordinator") }).strict(),
    z.object({ target: z.literal("report"), taskKey: id }).strict(),
  ]) }).strict(),
  header.extend({ method: z.literal("adopt"), payload: z.object({}).strict() }).strict(),
  header.extend({ method: z.literal("revoke"), payload: z.object({}).strict() }).strict(),
])
export const signedAuthorityIntentSchema = z.object({
  body: authorityIntentSchema, signature: z.string().length(88).regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict()
export type AuthorityRoot = z.infer<typeof authorityRootSchema>
export type AuthorityBinding = z.infer<typeof authorityBindingSchema>
export type AuthorityIntent = z.infer<typeof authorityIntentSchema>
export type SignedAuthorityIntent = z.infer<typeof signedAuthorityIntentSchema>
export type AuthorityMethod = AuthorityIntent["method"]
export type AuthorityJson = null | boolean | number | string | AuthorityJson[] | { [key: string]: AuthorityJson }
/** Only references/ACK metadata leave the business adapter. Never duplicate its
 * mission journal, arbitrary provider output, environment or host secrets. */
export const authorityEffectResultSchema = z.object({
  missionID: id, revision: revision.optional(), operationID: id.optional(), admissionID: id.optional(),
  prepared: z.literal(true).optional(), deleted: z.literal(true).optional(),
}).strict()
export type AuthorityEffectResult = z.infer<typeof authorityEffectResultSchema>

/** Storage and wire reads apply the same originating-intent semantics. Terminal
 * reservation is denial evidence, never proof of completed native controls. */
export function matchesAuthorityCompletion(intent: AuthorityIntent, completion: { outcome: "applied" | "rejected"; result: unknown }): boolean {
  if (intent.method === "adopt" || intent.method === "revoke") return z.object({ metadataOnly: z.literal(true) }).strict().safeParse(completion.result).success
  const parsed = authorityEffectResultSchema.safeParse(completion.result)
  if (!parsed.success || parsed.data.missionID !== intent.missionID) return false
  return completion.outcome !== "applied" || intent.method !== "lifecycle"
    || parsed.data.operationID === controlOperationID(intent.missionID, intent.requestID)
      && parsed.data.revision !== undefined && parsed.data.revision > intent.expectedRevision
}

export function matchesObservedLifecycle(intent: AuthorityIntent, result: unknown,
  observation: { revision: number; control?: MissionLifecycleOperation; controlUnavailable?: boolean }): boolean {
  const parsed = authorityEffectResultSchema.safeParse(result), control = observation.control
  return intent.method === "lifecycle" && matchesAuthorityCompletion(intent, { outcome: "applied", result })
    && parsed.success && !observation.controlUnavailable && !!control
    && control.id === parsed.data.operationID && control.missionID === intent.missionID && control.requestID === intent.requestID
    && control.action === intent.payload.action && control.expectedRevision === intent.expectedRevision && control.pending.length === 0
    && Number.isSafeInteger(control.completedRevision) && control.completedRevision! > intent.expectedRevision
    && parsed.data.revision! >= control.completedRevision! && parsed.data.revision! <= observation.revision
}

export class MissionAuthorityError extends Error {
  constructor(readonly code: "invalid-intent" | "untrusted-signer" | "binding-mismatch" | "policy-unqualified"
    | "storage-unavailable" | "storage-invalid" | "namespace-mismatch" | "capacity" | "request-conflict"
    | "revision-conflict" | "epoch-conflict" | "authorization-blocked" | "unsigned-privileged-method"
    | "trust-unavailable" | "observation-unavailable" | "effect-unavailable") {
    super(`Mission authority rejected: ${code}`)
  }
}
export function rejectAuthority(code: MissionAuthorityError["code"]): never { throw new MissionAuthorityError(code) }

/** Bounded portable JSON: reject getters, exotic objects, sparse arrays and cycles. */
export function canonicalAuthority(value: unknown, maxBytes = AUTHORITY_MAX_BYTES): string {
  let nodes = 0
  let bytes = 0
  const emit = (text: string) => {
    bytes += Buffer.byteLength(text)
    if (bytes > maxBytes) rejectAuthority("capacity")
    return text
  }
  const visit = (input: unknown, depth: number): string => {
    if (++nodes > 200_000 || depth > 20) rejectAuthority("invalid-intent")
    if (input === null || typeof input === "boolean") return emit(JSON.stringify(input))
    if (typeof input === "string") {
      if (input.length > maxBytes) rejectAuthority("capacity")
      return emit(JSON.stringify(input))
    }
    if (typeof input === "number" && Number.isFinite(input)) return emit(JSON.stringify(input))
    if (Array.isArray(input)) {
      if (input.length > 20_000 || Object.keys(input).length !== input.length) rejectAuthority("invalid-intent")
      const values: string[] = []
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
        if (!descriptor || !("value" in descriptor)) rejectAuthority("invalid-intent")
        values.push(visit(descriptor.value, depth + 1))
      }
      if (values.length > 1) emit(",".repeat(values.length - 1))
      return `${emit("[")}${values.join(",")}${emit("]")}`
    }
    if (typeof input !== "object" || !input || Object.getPrototypeOf(input) !== Object.prototype) rejectAuthority("invalid-intent")
    const keys = Reflect.ownKeys(input)
    if (keys.some(key => typeof key !== "string")) rejectAuthority("invalid-intent")
    const pairs = (keys as string[]).sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!
      if (!descriptor.enumerable || !("value" in descriptor)) rejectAuthority("invalid-intent")
      return `${emit(JSON.stringify(key))}${emit(":")}${visit(descriptor.value, depth + 1)}`
    })
    // Count each separator, not just one separator used by join().
    if (pairs.length > 1) emit(",".repeat(pairs.length - 1))
    return `${emit("{")}${pairs.join(",")}${emit("}")}`
  }
  return visit(value, 0)
}

export function authorityDigest(value: unknown): string {
  return createHash("sha256").update(canonicalAuthority(value)).digest("hex")
}
export function authoritySignerDigest(publicKey: KeyObject): string {
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex")
}
export function authoritySigningBytes(body: AuthorityIntent): Buffer {
  return Buffer.from(`${MISSION_AUTHORITY_POLICY}\n${canonicalAuthority(body)}`)
}

export interface ProvisionedAuthoritySigner extends Omit<AuthorityBinding, "missionID" | "coordinatorSessionID"> {
  publicKey: KeyObject
  provisioningGeneration: string
  policy: typeof MISSION_AUTHORITY_POLICY
  /** Host-managed qualification, not RPC booleans or an inferred old-writer lease. */
  qualification: "qualified" | "rotation-pending" | "old-writer-unexcluded" | "downgrade-unqualified"
}

export type AuthoritySignerSnapshot = Readonly<Omit<ProvisionedAuthoritySigner, "roots">> & {
  readonly roots: readonly Readonly<AuthorityRoot>[]
  readonly signerDigest: string
}

/** Detached, immutable verification identity. Never retain a live provisioning
 * object's key/roots as the identity authenticated by a previous signature. */
export function snapshotAuthoritySigner(signer: ProvisionedAuthoritySigner): AuthoritySignerSnapshot {
  if (!signer.provisioningGeneration || signer.provisioningGeneration.length > AUTHORITY_ID_MAX_LENGTH) rejectAuthority("untrusted-signer")
  const publicKey = createPublicKey({ key: signer.publicKey.export({ type: "spki", format: "der" }), type: "spki", format: "der" })
  const roots = Object.freeze(signer.roots.map(root => Object.freeze({ ...root })))
  return Object.freeze({ ...signer, publicKey, roots, signerDigest: authoritySignerDigest(publicKey) })
}

/** No default signer. Re-read the provisioned host map on every verification. */
export function authenticateAuthority(input: unknown, signers: readonly ProvisionedAuthoritySigner[]): AuthorityIntent {
  return authenticateAuthorityIntent(input, signers).body
}

export function authenticateAuthorityIntent(input: unknown, signers: readonly ProvisionedAuthoritySigner[]): {
  body: AuthorityIntent; signer: AuthoritySignerSnapshot
} {
  // Check portability/bounds before a schema parser can clone unbounded input.
  canonicalAuthority(input)
  const parsed = signedAuthorityIntentSchema.safeParse(input)
  if (!parsed.success) rejectAuthority("invalid-intent")
  const { body, signature } = parsed.data
  const signer = selectProvisionedSigner(body, signers)
  if (signer.policy !== MISSION_AUTHORITY_POLICY || signer.qualification !== "qualified") rejectAuthority("policy-unqualified")
  if (signer.publicKey.type !== "public" || signer.publicKey.asymmetricKeyType !== "ed25519") rejectAuthority("untrusted-signer")
  assertAuthorityScope(body, signer)
  const snapshot = snapshotAuthoritySigner(signer)
  const bytes = Buffer.from(signature, "base64")
  if (bytes.toString("base64") !== signature || !verify(null, authoritySigningBytes(body), snapshot.publicKey, bytes)) rejectAuthority("untrusted-signer")
  return { body, signer: snapshot }
}

export function selectProvisionedSigner(binding: AuthorityBinding, signers: readonly ProvisionedAuthoritySigner[]): ProvisionedAuthoritySigner {
  const matches = signers.filter(signer => signer.authorityID === binding.authorityID && signer.keyID === binding.keyID
    && signer.profileID === binding.profileID && signer.executionHost === binding.executionHost
    && signer.namespace === binding.namespace && signer.projectID === binding.projectID
    && signer.projectCanonical === binding.projectCanonical && canonicalAuthority(signer.roots) === canonicalAuthority(binding.roots))
  if (matches.length !== 1) rejectAuthority("untrusted-signer")
  return matches[0]
}

export function assertAuthorityScope(binding: AuthorityBinding, expected: Omit<AuthorityBinding, "missionID" | "coordinatorSessionID">): void {
  for (const key of ["authorityID", "keyID", "profileID", "executionHost", "namespace", "projectID", "projectCanonical"] as const) {
    if (binding[key] !== expected[key]) rejectAuthority("binding-mismatch")
  }
  if (canonicalAuthority(binding.roots) !== canonicalAuthority(expected.roots)
    || new Set(binding.roots.map(root => root.directory)).size !== binding.roots.length) rejectAuthority("binding-mismatch")
}
