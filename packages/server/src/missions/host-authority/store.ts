import { createPrivateKey, generateKeyPairSync, randomUUID, sign as signBytes } from "node:crypto"
import type { FastifyRequest } from "fastify"
import { authorityBindingSchema, authorityDigest, authorityIntentSchema, authoritySignerDigest, authoritySigningBytes,
  canonicalAuthority, snapshotAuthoritySigner, type AuthorityBinding, type AuthoritySignerSnapshot,
  type ProvisionedAuthoritySigner, type SignedAuthorityIntent } from "../authority-protocol"
import type { AuthorityGrant } from "../authority-store"
import { assertSynchronousAuthorityGuard } from "../authority-synchronous"
import { deny, matchBinding, publicSigner, type HostDocument } from "./model"
import { physical, ProtectedAuthorityFiles } from "./private-files"
import { HostAuthorityAdmissions, observeAuthorityRead, type QualificationLease } from "./qualification"
import { acceptMirror, assertMirror, stageMirror, type HostAuthorityRegistry, type NativeAuthorityMirrorReader } from "./registry"
import { parseDerivedCallBody, derivedSigningBytes, assertVerifiedDerivedInvocation, authenticateDerivedCall,
  type DerivedInvocationLease, type SignedDerivedCall } from "../derived-call-protocol"
import { controlOperationID } from "../receipt-identity"

const targetSchema = authorityBindingSchema.omit({ authorityID: true, keyID: true, profileID: true, executionHost: true })
export type HostAuthorityTarget = import("zod").infer<typeof targetSchema>
export interface HostAuthoritySnapshot {
  readonly revision: number
  readonly state: "staged" | "qualified" | "revoked"
  readonly generation: string
  readonly epoch: number
  readonly binding: Readonly<AuthorityBinding>
  readonly signer: AuthoritySignerSnapshot | null
  readonly mirror: Readonly<AuthorityGrant> | null
  readonly pendingDigest: string | null
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

/** Explicit human operations only. No import registers a route/plugin, creates
 * storage, obtains a handshake, adopts a mission, starts work or schedules sends.
 * Construct through the existing trusted backend/native parent, not RPC/options. */
export class ProtectedHostAuthority implements HostAuthorityRegistry {
  private lease?: QualificationLease
  constructor(private readonly files: ProtectedAuthorityFiles, private readonly admissions: HostAuthorityAdmissions,
    private readonly native?: NativeAuthorityMirrorReader) {
    if (canonicalAuthority(files.descriptor) !== canonicalAuthority(admissions.descriptor)) deny("scope-mismatch")
  }

  /** Stage a locally generated key, or rotate ONLY after explicit local denial
   * plus completed native revocation and a fresh qualified quiescence proof.
   * Existing/missing/corrupt files are never repaired or silently replaced. */
  async prepare(request: FastifyRequest, target: HostAuthorityTarget, expectedRevision: number | null, signal?: AbortSignal): Promise<HostAuthoritySnapshot> {
    signal?.throwIfAborted()
    canonicalAuthority(target)
    const parsed = targetSchema.parse(target), descriptor = this.files.descriptor
    const binding = { ...parsed, authorityID: randomUUID(), keyID: randomUUID(), profileID: descriptor.scope.key, executionHost: descriptor.executionHost }
    return this.admissions.human(request, binding, async humanFence => {
      let rotation: QualificationLease | undefined
      let rotationDigest: string | undefined
      if (expectedRevision !== null) {
        const old = await this.required()
        if (old.revision !== expectedRevision || !old.revoked || old.pending || old.mirror?.grant.state !== "revoked") deny("rotation-unqualified")
        if (canonicalAuthority(targetSchema.parse(parsed)) !== canonicalAuthority(targetSchema.parse(Object.fromEntries(Object.keys(targetSchema.shape).map(key => [key, old.manifest[key as keyof AuthorityBinding]]))))) deny("binding-mismatch")
        rotation = await this.admissions.qualify(old.manifest, humanFence, old, signal)
        if (!old.daemonStorageID || old.daemonStorageID !== rotation.daemonStorageID) deny("native-storage-mismatch")
        rotationDigest = authorityDigest(old)
      }
      const key = generateKeyPairSync("ed25519")
      const document = await this.files.cas(expectedRevision, async current => {
        if (current && (!current.revoked || current.pending || current.mirror?.grant.state !== "revoked"
          || authorityDigest(current) !== rotationDigest)) deny("rotation-unqualified")
        return { v: 1, revision: (current?.revision ?? 0) + 1, descriptor,
          storageIdentity: physical(this.files.directory), installationID: current?.installationID ?? randomUUID(), generation: randomUUID(), manifest: binding,
          publicKey: key.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
          privateKey: key.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), signerDigest: authoritySignerDigest(key.publicKey),
          revoked: false, epochFloor: current?.mirror?.grant.epoch ?? 0, anchor: null,
          daemonStorageID: current?.daemonStorageID ?? null, mirror: null, pending: null }
      }, () => { humanFence(); rotation?.assertCurrent() }, true)
      this.lease = undefined
      return this.snapshot(document)
    }, signal)
  }

  /** Public projection only; reads never generate a key/anchor or reauthorize. */
  async read(): Promise<HostAuthoritySnapshot | undefined> {
    const doc = await this.files.read()
    if (!doc) return undefined
    return this.snapshot(doc)
  }
  async readSigners(): Promise<readonly ProvisionedAuthoritySigner[]> {
    const doc = await this.required()
    if (doc.revoked || !doc.anchor || !this.lease) return []
    const fresh = this.files.readSync()
    this.current(fresh)
    // Core creates its own detached immutable snapshot from this public signer.
    return [publicSigner(fresh)]
  }

  /** Requalify only an already accepted Play after a backend restart. No new
   * grant, key, epoch, signature, prompt or human-auth substitution is issued.
   * A missing/paused/revoked/ambiguous mirror requires explicit human action. */
  async restore(signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<HostAuthoritySnapshot> {
    let publishedLease: QualificationLease | undefined
    const before = await this.required(), mirror = before.mirror
    if (!this.native?.restore || before.revoked || before.pending || !before.anchor || !before.daemonStorageID || !mirror
      || mirror.disabled || mirror.grant.state !== "active" || !mirror.grant.sendsEnabled) deny("restoration-blocked")
    const native = this.native
    try {
      return await this.admissions.existing(before.manifest, async ownedFence => {
        const lease = await this.admissions.qualify(before.manifest, ownedFence, before, signal)
        if (before.daemonStorageID !== lease.daemonStorageID) deny("native-storage-mismatch")
        const readNative = async () => {
          const observation = await observeAuthorityRead(native.restore!(structuredClone(mirror.grant), signal), signal)
          ownedFence(); lease.assertCurrent()
          const control = observation.control
          if (observation.terminal || observation.pendingRequestIDs.length || observation.controlPending
            || observation.status !== "active" || observation.runState !== "running"
            || !Number.isSafeInteger(observation.revision) || observation.revision < mirror.nativeRevision
            || canonicalAuthority(observation.grant) !== canonicalAuthority(mirror.grant)
            || !control || control.action !== "start" || control.missionID !== mirror.grant.missionID
            || control.id !== controlOperationID(control.missionID, control.requestID)
            || !Array.isArray(control.pending) || control.pending.length || !Array.isArray(control.targets) || !control.targets.length
            || !control.targets.every(target => before.manifest.roots.some(root => root.directory === target.location.directory))
            || !Number.isSafeInteger(control.completedRevision) || control.completedRevision! <= control.expectedRevision
            || control.completedRevision! > observation.revision) deny("restoration-mismatch")
          return observation
        }
        const first = await readNative(), second = await readNative()
        if (canonicalAuthority(first) !== canonicalAuthority(second)) deny("native-observation-changed")
        const document = await this.files.cas(before.revision, async current => {
          if (!current || authorityDigest(current) !== authorityDigest(before)) deny("restoration-changed")
          const next = structuredClone(current)
          next.anchor = lease.digest; next.revision++
          return next
        }, () => {
          ownedFence(); lease.assertCurrent()
          if (authorityDigest(this.files.readSync(true)) !== authorityDigest(before)) deny("restoration-changed")
        })
        ownedFence(); lease.assertCurrent()
        if (authorityDigest(this.files.readSync()) !== authorityDigest(document)) deny("restoration-changed")
        publishedLease = lease; this.lease = lease
        return this.snapshot(document)
      }, signal)
    } catch (error) {
      if (publishedLease && this.lease === publishedLease) this.lease = undefined
      throw error
    }
  }

  /** Typed product allowlist. Durable protected staging happens BEFORE a
   * signature leaves the host. A lost reply never frees/replays its reservation. */
  async sign(request: FastifyRequest, input: unknown, expectedRevision: number, signal?: AbortSignal): Promise<SignedAuthorityIntent> {
    signal?.throwIfAborted()
    canonicalAuthority(input)
    const body = authorityIntentSchema.parse(input)
    return this.admissions.human(request, body, async humanFence => {
      const before = await this.required()
      matchBinding(body, before.manifest)
      if (before.revoked) deny("signer-revoked")
      if (before.revision !== expectedRevision) deny("revision-conflict")
      // An old accepted mirror is not a first-time staged key. Unknown storage
      // requires explicit adoption (which disables sends until separate Play).
      if (!before.daemonStorageID && (before.anchor || before.mirror || before.epochFloor)
        && body.method !== "adopt") deny("native-storage-mismatch")
      const lease = await this.admissions.qualify(before.manifest, humanFence, before, signal)
      if (before.daemonStorageID && before.daemonStorageID !== lease.daemonStorageID) deny("native-storage-mismatch")
      const doc = await this.files.cas(expectedRevision, async current => {
        if (!current || authorityDigest(current) !== authorityDigest(before)) deny("signer-changed")
        const next = structuredClone(current)
        stageMirror(next, body)
        next.anchor = lease.digest; next.daemonStorageID = lease.daemonStorageID; next.revision++
        return next
      }, () => { humanFence(); lease.assertCurrent() })
      this.lease = lease
      // Read the exact private state afresh, with privacy/claim/native fences,
      // not a stale key retained across the publication await.
      const fresh = this.files.readSync()
      if (authorityDigest(fresh) !== authorityDigest(doc)) deny("signer-changed")
      humanFence(); this.current(fresh)
      const key = createPrivateKey({ key: Buffer.from(fresh.privateKey, "base64"), type: "pkcs8", format: "der" })
      const signature = signBytes(null, authoritySigningBytes(body), key).toString("base64")
      humanFence(); this.current(this.files.readSync())
      return freeze({ body: structuredClone(body), signature })
    }, signal)
  }

  /** Accept only freshly read native-core evidence. Caller JSON is never a
   * completion source. Two native reads bracket preparation/publication; exact
   * pending digest, signer generation and denial monotonicity are mandatory. */
  async accept(request: FastifyRequest, pendingDigest: string, expectedRevision: number, signal?: AbortSignal): Promise<HostAuthoritySnapshot> {
    signal?.throwIfAborted()
    const before = await this.required(), pending = before.pending
    if (!this.native || !pending || pending.digest !== pendingDigest) deny("native-observation-unavailable")
    return this.admissions.human(request, before.manifest, async humanFence => {
      const readNative = async () => {
        try { return await this.native!.read(pending.body) }
        catch { deny("native-observation-unavailable") }
      }
      const first = await readNative()
      humanFence()
      const second = await readNative()
      if (canonicalAuthority(first) !== canonicalAuthority(second)) deny("native-observation-changed")
      const doc = await this.files.cas(expectedRevision, async current => {
        if (!current || authorityDigest(current) !== authorityDigest(before)) deny("reservation-changed")
        this.current(current)
        const next = structuredClone(current)
        acceptMirror(next, second); next.revision++
        return next
      }, () => { humanFence(); this.current(this.files.readSync(true)) })
      return this.snapshot(doc)
    }, signal)
  }

  /** Local denial needs no new execution qualification/capacity/native effect.
   * It does not claim native interruption or native grant revocation. */
  async revoke(request: FastifyRequest, expectedRevision: number): Promise<HostAuthoritySnapshot> {
    const before = await this.required()
    return this.admissions.human(request, before.manifest, async humanFence => {
      const doc = await this.files.cas(expectedRevision, async current => {
        if (!current) deny("key-lost")
        const next = structuredClone(current)
        next.revoked = true; next.anchor = null; next.revision++
        if (next.mirror) next.mirror.disabled = true
        return next
      }, humanFence, false, true)
      this.lease = undefined
      return this.snapshot(doc)
    })
  }

  assertManagedIncarnation(): true { return this.current(this.files.readSync()) }
  /** Mandatory final effect fence for an already signed original reservation.
   * Terminal controls may retain a disabled grant; this is not send admission. */
  assertReservationCurrent(intent: import("../authority-protocol").AuthorityIntent): true {
    const doc = this.files.readSync()
    this.current(doc)
    matchBinding(intent, doc.manifest)
    if (doc.pending?.digest !== authorityDigest(intent)) deny("reservation-changed")
    return true
  }
  assertSignerCurrent(signer: AuthoritySignerSnapshot): true {
    const doc = this.files.readSync()
    this.current(doc)
    const fresh = snapshotAuthoritySigner(publicSigner(doc))
    for (const key of ["authorityID", "keyID", "profileID", "executionHost", "namespace", "projectID", "projectCanonical", "policy", "qualification", "provisioningGeneration", "signerDigest"] as const) {
      if (fresh[key] !== signer[key]) deny("signer-changed")
    }
    if (canonicalAuthority(fresh.roots) !== canonicalAuthority(signer.roots)
      || authoritySignerDigest(signer.publicKey) !== fresh.signerDigest) deny("signer-changed")
    return true
  }
  async assertHostGrant(grant: AuthorityGrant): Promise<void> {
    const doc = await this.required()
    this.current(doc); assertMirror(doc, grant)
    this.assertHostGrantCurrent(grant)
  }
  assertHostGrantCurrent(grant: AuthorityGrant): true {
    const doc = this.files.readSync()
    this.current(doc)
    return assertMirror(doc, grant)
  }
  /** Internal autonomous derivation, NEVER a human RPC/signing fallback. The
   * genuine invocation verifier is mandatory at the construction seam. This
   * signs references only; native claim reservation is separate and precedes any
   * executor effect. No key/plan/host-grant mutation or human-auth relaxation. */
  signDerivedCall(input: unknown, grant: AuthorityGrant, invocation: DerivedInvocationLease): SignedDerivedCall {
    const body = parseDerivedCallBody(input)
    assertVerifiedDerivedInvocation(invocation, body, "reserve")
    const doc = this.files.readSync()
    this.current(doc); assertMirror(doc, grant); matchBinding(body, doc.manifest)
    if (body.epoch !== grant.epoch || body.provisioningGeneration !== doc.generation
      || body.signerDigest !== doc.signerDigest) deny("derived-signer-mismatch")
    const key = createPrivateKey({ key: Buffer.from(doc.privateKey, "base64"), type: "pkcs8", format: "der" })
    const signature = signBytes(null, derivedSigningBytes(body), key).toString("base64")
    assertVerifiedDerivedInvocation(invocation, body, "reserve")
    this.assertHostGrantCurrent(grant)
    return freeze({ body: structuredClone(body), signature })
  }
  /** Admitted evidence only, including after local revoke/Pause/Stop. Does not
   * qualify a signer, restore sends or allow rotation to borrow the old key.
   * Caller MUST additionally authenticate a fresh genuine report/end invocation. */
  assertDerivedEvidence(signed: SignedDerivedCall): true {
    const doc = this.files.readSync(), body = parseDerivedCallBody(signed.body)
    matchBinding(body, doc.manifest)
    if (body.provisioningGeneration !== doc.generation || body.signerDigest !== doc.signerDigest
      || !doc.mirror || body.epoch > doc.mirror.grant.epoch) deny("derived-evidence-mismatch")
    authenticateDerivedCall(signed, snapshotAuthoritySigner(publicSigner(doc)))
    return true
  }
  private current(doc: HostDocument): true {
    if (!doc.anchor || !this.lease || doc.anchor !== this.lease.digest) deny("native-qualification-unavailable")
    if (doc.revoked) deny("signer-revoked")
    if (doc.generation !== this.lease.provisioningGeneration || doc.signerDigest !== this.lease.signerDigest
      || authorityDigest(doc.manifest) !== this.lease.bindingDigest || doc.daemonStorageID !== this.lease.daemonStorageID) deny("signer-changed")
    return assertSynchronousAuthorityGuard(this.lease.assertCurrent, "policy-unqualified")
  }
  private async required(): Promise<HostDocument> { return await this.files.read() ?? deny("key-lost") }
  private snapshot(doc: HostDocument): HostAuthoritySnapshot {
    const qualified = !doc.revoked && Boolean(doc.anchor && this.lease && doc.anchor === this.lease.digest)
    if (qualified) this.current(doc)
    return freeze({ revision: doc.revision, state: doc.revoked ? "revoked" : qualified ? "qualified" : "staged", generation: doc.generation,
      epoch: doc.mirror?.grant.epoch ?? doc.epochFloor,
      binding: structuredClone(doc.manifest), signer: qualified ? snapshotAuthoritySigner(publicSigner(doc)) : null,
      mirror: doc.mirror && structuredClone(doc.mirror.grant), pendingDigest: doc.pending?.digest ?? null })
  }
}
