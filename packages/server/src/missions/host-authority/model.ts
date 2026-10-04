import { createPrivateKey, createPublicKey } from "node:crypto"
import { z } from "zod"
import { authorityBindingSchema, authorityDigest, authorityIntentSchema, authoritySignerDigest,
  canonicalAuthority, MISSION_AUTHORITY_POLICY, type AuthorityBinding, type ProvisionedAuthoritySigner } from "../authority-protocol"
import { authorityGrantSchema } from "../authority-store"
import { MAX_BYTES, type Scope } from "../../host-lifetime/protocol"

export class HostAuthorityError extends Error {
  constructor(readonly code: string) { super(`Host mission authority rejected: ${code}`) }
}
export function deny(code: string): never { throw new HostAuthorityError(code) }
const bounded = z.string().min(1).max(240)
export const descriptorSchema = z.object({
  scope: z.object({ channel: bounded, configIdentity: z.string().min(1).max(4096), key: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  physicalProfile: z.string().min(1).max(4096), executionHost: bounded,
}).strict()
export interface HostAuthorityDescriptor { scope: Scope; physicalProfile: string; executionHost: string }
export const documentSchema = z.object({
  v: z.literal(1), revision: z.number().int().positive().safe(), descriptor: descriptorSchema,
  storageIdentity: z.string().min(1).max(4096), installationID: z.string().uuid(), generation: z.string().uuid(),
  manifest: authorityBindingSchema, publicKey: z.string().min(1).max(1024),
  privateKey: z.string().min(1).max(1024), signerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  revoked: z.boolean(), epochFloor: z.number().int().nonnegative().safe(), anchor: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  mirror: z.object({ grant: authorityGrantSchema, nativeRevision: z.number().int().nonnegative().safe(), disabled: z.boolean() }).strict().nullable(),
  pending: z.object({ body: authorityIntentSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable(),
}).strict()
/** INTERNAL secret-bearing state. Never return it, stringify an error containing
 * it, or pass it to the plugin/native bridge/UI. Public reads are projections. */
export type HostDocument = z.infer<typeof documentSchema>

export function parseDocument(value: unknown, descriptor: HostAuthorityDescriptor, storageIdentity: string): HostDocument {
  try {
    canonicalAuthority(value, MAX_BYTES)
    const doc = documentSchema.parse(value)
    if (canonicalAuthority(doc.descriptor) !== canonicalAuthority(descriptor) || doc.storageIdentity !== storageIdentity) deny("profile-moved")
    if (doc.manifest.profileID !== descriptor.scope.key || doc.manifest.executionHost !== descriptor.executionHost) deny("scope-mismatch")
    const key = createPrivateKey({ key: Buffer.from(doc.privateKey, "base64"), format: "der", type: "pkcs8" })
    if (key.asymmetricKeyType !== "ed25519" || key.export({ type: "pkcs8", format: "der" }).toString("base64") !== doc.privateKey) deny("key-invalid")
    const publicKey = createPublicKey(key)
    if (publicKey.export({ type: "spki", format: "der" }).toString("base64") !== doc.publicKey
      || authoritySignerDigest(publicKey) !== doc.signerDigest) deny("key-invalid")
    if (doc.pending && (authorityDigest(doc.pending.body) !== doc.pending.digest || !sameBinding(doc.pending.body, doc.manifest))) deny("intent-mismatch")
    if (doc.mirror && (!sameBinding(doc.mirror.grant, doc.manifest) || doc.mirror.grant.signerDigest !== doc.signerDigest)) deny("mirror-mismatch")
    return doc
  } catch (error) { if (error instanceof HostAuthorityError) throw error; deny("storage-invalid") }
}
export function sameBinding(a: AuthorityBinding, b: AuthorityBinding): boolean {
  return canonicalAuthority(bindingOf(a)) === canonicalAuthority(bindingOf(b))
}
// Parsing strict schemas cannot accept extended grant/intent fields. Project only
// declared binding fields without ever changing their values.
export function bindingOf(value: AuthorityBinding): AuthorityBinding {
  return authorityBindingSchema.parse(Object.fromEntries(Object.keys(authorityBindingSchema.shape).map(key => [key, value[key as keyof AuthorityBinding]])))
}
export function matchBinding(a: AuthorityBinding, b: AuthorityBinding): void {
  if (canonicalAuthority(bindingOf(a)) !== canonicalAuthority(bindingOf(b))) deny("binding-mismatch")
}
export function publicSigner(doc: HostDocument): ProvisionedAuthoritySigner {
  const { missionID: _mission, coordinatorSessionID: _coordinator, ...binding } = doc.manifest
  return { ...binding, publicKey: createPublicKey({ key: Buffer.from(doc.publicKey, "base64"), format: "der" as const, type: "spki" as const }),
    provisioningGeneration: doc.generation, policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" as const }
}
