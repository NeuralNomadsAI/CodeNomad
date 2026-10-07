import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { FastifyRequest } from "fastify"
import type { AuthManager } from "../../auth/manager"
import { authorityDigest, authorityRootSchema, canonicalAuthority, type AuthorityBinding } from "../authority-protocol"
import { assertSynchronousAuthorityGuard } from "../authority-synchronous"
import { deny, descriptorSchema, matchBinding, type HostAuthorityDescriptor } from "./model"
import { assertExplicitQuiescence, quiescenceSchema } from "./quiescence"

const text = z.string().min(1).max(240)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const owner = z.object({ pid: z.number().int().positive().safe(), startIdentity: z.string().min(1).max(512) }).strict()
const observationSchema = z.object({
  nonce: z.string().uuid(), descriptor: descriptorSchema,
  hostGeneration: z.string().uuid(), attestationID: text,
  hostOwner: owner, backendOwner: owner,
  provisioningGeneration: z.string().uuid(), signerDigest: digest,
  writer: z.object({ registrationID: text, incarnationID: text, artifactDigest: digest, daemonStorageID: text,
    namespace: z.string().uuid(), projectID: text, projectCanonical: z.string().min(1).max(4096),
    coordinatorSessionID: text, roots: z.array(authorityRootSchema).min(1).max(32) }).strict(),
  quiescence: quiescenceSchema,
}).strict()
export type ManagedAuthorityObservation = z.infer<typeof observationSchema>

/** Only the trusted persistent native parent's private capability transport may
 * implement this. There is deliberately NO default JSON verifier, shared HTTP
 * secret store, environment flag, proof issuer or production mock implementation.
 * verify must authenticate native attestation, not parse caller-supplied fields. */
export interface PrivateManagedAuthorityBridge {
  /** Use readNativeDiscoveryBoundary on the authenticated connected daemon.
   * Bootstrap environment/CLI debug paths are not discovery authority. */
  readDiscoveryBoundary(signal?: AbortSignal): Promise<{ globalDirectory: string; configDigest: string }>
  handshake(input: { nonce: string; descriptor: HostAuthorityDescriptor; binding: AuthorityBinding;
    provisioningGeneration: string; signerDigest: string }, signal?: AbortSignal): Promise<unknown>
  verify(proof: unknown): ManagedAuthorityObservation
  assertCurrent(proof: unknown, observationDigest: string): true
}
export interface OwnedAuthorityMutationGate {
  /** Real WorkspaceManager/connection/session-send/family/deletion admission.
   * Root identities must be physical observations, never caller path prefixes. */
  withOwned<T>(binding: AuthorityBinding, operation: (assertCurrent: () => true) => Promise<T>, signal?: AbortSignal): Promise<T>
  /** Restoration may observe only an already authenticated connection and
   * registered roots. No service start, plugin provisioning or inventory scan. */
  withExisting?<T>(binding: AuthorityBinding, operation: (assertCurrent: () => true) => Promise<T>, signal: AbortSignal): Promise<T>
}
export interface QualificationLease {
  readonly digest: string
  readonly hostGeneration: string
  readonly provisioningGeneration: string
  readonly signerDigest: string
  readonly bindingDigest: string
  readonly daemonStorageID: string
  assertCurrent(): true
}

/** Only read-only preparation may abandon an observer. Never race a native
 * mutation/publication against cancellation and release its admission early. */
export async function observeAuthorityRead<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
  try { const result = await Promise.race([pending, cancelled]); signal.throwIfAborted(); return result }
  finally { signal.removeEventListener("abort", abort) }
}

/** No independent login/session registry. AuthManager remains the sole HTTP
 * human boundary. Passing a request here is not itself proof of authentication. */
export class HostAuthorityAdmissions {
  readonly descriptor: HostAuthorityDescriptor
  constructor(private readonly auth: Pick<AuthManager, "isAuthEnabled" | "getSessionFromRequest">,
    private readonly owned: OwnedAuthorityMutationGate, descriptor: HostAuthorityDescriptor,
    private readonly bridge?: PrivateManagedAuthorityBridge) {
    this.descriptor = descriptorSchema.parse(descriptor)
    Object.freeze(this.descriptor.scope); Object.freeze(this.descriptor)
  }

  async human<T>(request: FastifyRequest, binding: AuthorityBinding, operation: (fence: () => true) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const identity = this.auth.getSessionFromRequest(request)
    if (!this.auth.isAuthEnabled() || !identity || identity.sessionId === "auth-disabled") deny("human-auth-required")
    if (binding.profileID !== this.descriptor.scope.key || binding.executionHost !== this.descriptor.executionHost) deny("scope-mismatch")
    return this.owned.withOwned(binding, async ownedFence => {
      const fence = (): true => {
        signal?.throwIfAborted()
        const current = this.auth.getSessionFromRequest(request)
        if (!this.auth.isAuthEnabled() || !current || current.sessionId !== identity.sessionId || current.username !== identity.username) deny("human-auth-lost")
        return assertSynchronousAuthorityGuard(ownedFence, "policy-unqualified")
      }
      fence()
      const result = await operation(fence)
      fence()
      return result
    }, signal)
  }

  /** Existing protected decisions only; the store must validate the saved grant.
   * This supplies ownership, not permission to generate/sign/adopt new work. */
  async existing<T>(binding: AuthorityBinding, operation: (fence: () => true) => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    if (!this.owned.withExisting) deny("existing-ownership-unavailable")
    if (binding.profileID !== this.descriptor.scope.key || binding.executionHost !== this.descriptor.executionHost) deny("scope-mismatch")
    return this.owned.withExisting(binding, async ownedFence => {
      const fence = (): true => { signal.throwIfAborted(); return assertSynchronousAuthorityGuard(ownedFence, "policy-unqualified") }
      fence()
      const result = await operation(fence)
      fence()
      return result
    }, signal)
  }

  async qualify(binding: AuthorityBinding, currentFence: () => true, signer: { generation: string; signerDigest: string }, origin?: AbortSignal): Promise<QualificationLease> {
    const signal = origin ? AbortSignal.any([origin, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
    signal.throwIfAborted()
    if (!this.bridge) deny("native-qualification-unavailable")
    const bridge = this.bridge
    const readDiscovery = async () => {
      try { return await observeAuthorityRead(bridge.readDiscoveryBoundary(signal), signal) }
      catch { origin?.throwIfAborted(); deny("native-observation-unavailable") }
    }
    const nonce = randomUUID()
    currentFence()
    const discovery = await readDiscovery()
    currentFence()
    let proof: unknown
    try { proof = await observeAuthorityRead(bridge.handshake({ nonce, descriptor: this.descriptor, binding,
      provisioningGeneration: signer.generation, signerDigest: signer.signerDigest }, signal), signal) }
    catch { origin?.throwIfAborted(); deny("native-observation-unavailable") }
    currentFence()
    let observation: ManagedAuthorityObservation
    try { observation = observationSchema.parse(bridge.verify(proof)) } catch { deny("native-proof-invalid") }
    if (observation.nonce !== nonce || observation.backendOwner.pid !== process.pid
      || canonicalAuthority(observation.descriptor) !== canonicalAuthority(this.descriptor)
      || observation.provisioningGeneration !== signer.generation || observation.signerDigest !== signer.signerDigest) deny("native-proof-mismatch")
    matchBinding({ ...binding, ...observation.writer }, binding)
    assertExplicitQuiescence(observation.quiescence, observation.writer)
    const freshDiscovery = await readDiscovery()
    currentFence()
    if (canonicalAuthority(discovery) !== canonicalAuthority(freshDiscovery) || observation.quiescence.discoveryRoot !== freshDiscovery.globalDirectory
      || observation.quiescence.configDigest !== freshDiscovery.configDigest) deny("native-discovery-changed")
    const immutable = JSON.parse(canonicalAuthority(observation)) as ManagedAuthorityObservation
    const proofDigest = authorityDigest(immutable)
    // Qualification's preparation deadline does not expire an accepted grant;
    // the private retained owner/channel is the sustained admission fence.
    const assertCurrent = (): true => assertSynchronousAuthorityGuard(() => bridge.assertCurrent(proof, proofDigest), "policy-unqualified")
    assertCurrent(); currentFence()
    return Object.freeze({ digest: proofDigest, hostGeneration: immutable.hostGeneration, provisioningGeneration: immutable.provisioningGeneration,
      signerDigest: immutable.signerDigest, bindingDigest: authorityDigest(binding), daemonStorageID: immutable.writer.daemonStorageID, assertCurrent })
  }
}
