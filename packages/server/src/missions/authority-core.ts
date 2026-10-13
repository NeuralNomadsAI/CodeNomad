import {
  assertAuthorityScope, authenticateAuthorityIntent, authorityDigest, authoritySignerDigest, canonicalAuthority, MISSION_AUTHORITY_POLICY,
  rejectAuthority, selectProvisionedSigner, MissionAuthorityError, authorityEffectResultSchema, AUTHORITY_MAX_BYTES, matchesAuthorityCompletion, matchesObservedLifecycle,
  type AuthorityBinding, type AuthorityIntent, type AuthorityEffectResult, type AuthorityRoot,
  snapshotAuthoritySigner, type ProvisionedAuthoritySigner, type AuthoritySignerSnapshot,
} from "./authority-protocol"
import {
  bindingFromIntent, NativeMissionAuthorityStore, type AuthorityDocument, type AuthorityGrant, type AuthorityReceipt,
} from "./authority-store"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { authorityReceiptQuerySchema, type AuthorityReceiptRead } from "./authority-receipt"
import type { MissionLifecycleOperation } from "./lifecycle-model"

export interface AuthorityMissionObservation {
  missionID: string
  coordinatorSessionID: string
  revision: number
  status: "active" | "completed" | "failed" | "stopped"
  runState: "prepared" | "running" | "paused" | "stopped"
  controlPending: boolean
  control?: MissionLifecycleOperation
  controlUnavailable?: boolean
  /** Exact owned physical identities, validated against every saved/live actor.
   * No prefix matching, speculative aliases or session recreation. */
  roots: AuthorityRoot[]
}
export interface NativeAuthorityAdapter {
  /** Current native plugin incarnation/disposal fence (not desktop presence). */
  assertActive(): void
  /** Trusted host provisioning, never loaded from RPC input/project storage. */
  readSigners(): Promise<readonly ProvisionedAuthoritySigner[]>
  /** Synchronous host-provisioning generation/key/qualification fence at actual
   * publication. It must consult the current trusted map, not a captured read. */
  assertSignerCurrent(signer: AuthoritySignerSnapshot): true
  observeMission(missionID: string): Promise<AuthorityMissionObservation | undefined>
  /** Journal capacity, including per-target control/cleanup receipts, checked
   * under project exclusion. Actual journal publication must reserve those slots
   * before effects; this is not permission to bypass its own bounded append. */
  assertJournalCapacity(intent: AuthorityIntent): Promise<void>
}
export interface AuthorityOperationResult {
  receipt: AuthorityReceipt
  /** Always CURRENT state, never the grant captured in an old adoption receipt. */
  grant: AuthorityGrant | null
}
export type AuthorityEffectIntent = Exclude<AuthorityIntent, { method: "adopt" | "revoke" }>
export interface AuthorityEffectAdapter {
  /** Restrictive originating-request lease. Never supplies signature/grant trust;
   * canonical HUMAN RPCs pin it before their first await. */
  readonly assertCurrent?: () => true
  /** Optional wrapper pin: rejects a different verification identity before ANY
   * reservation, including metadata-only adoption. Never supplies trust itself. */
  readonly expectedSigner?: AuthoritySignerSnapshot
  /** Native business operation. No generic tools, caller session, prompt or HTTP
   * passthrough. Reconstruct business inputs from this verified typed intent.
   * Observe a published reservation before effects, apply existing CAS/ownership
   * fences, use stable IDs, and return only bounded non-secret receipts. */
  apply(intent: AuthorityEffectIntent, signal: AbortSignal): Promise<AuthorityEffectResult>
}

export class NativeMissionAuthority {
  constructor(readonly store: NativeMissionAuthorityStore, private readonly adapter: NativeAuthorityAdapter) {}

  async challenge(nonce: string): Promise<{
    nonce: string; namespace: string; policy: typeof MISSION_AUTHORITY_POLICY;
    projectID: string; projectCanonical: string;
  }> {
    this.adapter.assertActive()
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) rejectAuthority("invalid-intent")
    const doc = await this.store.read()
    // Informational read only. Transport authentication and host-registry checks
    // belong to the host; echoing a nonce is not trust provisioning or approval.
    return { nonce, namespace: doc.namespace, policy: MISSION_AUTHORITY_POLICY,
      projectID: doc.projectID, projectCanonical: doc.projectCanonical }
  }

  /** Bounded read projection only: no signing keys, environment, journal copy or
   * persisted intent payloads. Reads cannot turn legacy running into authority. */
  async state(missionID: string): Promise<{
    continuity: "needs-authorization" | "active" | "revoked"
    grant: AuthorityGrant | null
    terminal: "stopped" | "deleted" | null
    pendingRequestIDs: string[]
  }> {
    this.adapter.assertActive()
    if (!missionID || missionID.length > 240) rejectAuthority("invalid-intent")
    const doc = await this.store.read()
    const grant = doc.grants.find(item => item.missionID === missionID) ?? null
    await this.assertLifecycleCompletions(doc, missionID)
    this.adapter.assertActive()
    return { continuity: grant?.state ?? "needs-authorization", grant,
      terminal: doc.terminals.find(item => item.missionID === missionID)?.state ?? null,
      pendingRequestIDs: doc.receipts.filter(item => item.intent.missionID === missionID && !item.completion).map(item => item.requestID) }
  }

  /** Project-readable evidence only. No caller identity/grant/signer acquisition,
   * transaction, initialization, repair, capacity reservation or business effect.
   * A historical receipt remains readable after revocation/deletion/rotation. */
  async readReceipt(input: unknown): Promise<AuthorityReceiptRead> {
    this.adapter.assertActive()
    canonicalAuthority(input, AUTHORITY_MAX_BYTES + 128)
    const parsed = authorityReceiptQuerySchema.safeParse(input)
    if (!parsed.success) rejectAuthority("invalid-intent")
    const { intent, digest } = parsed.data
    canonicalAuthority(intent)
    if (authorityDigest(intent) !== digest) rejectAuthority("request-conflict")
    const doc = await this.store.read()
    this.adapter.assertActive()
    if (intent.namespace !== doc.namespace) rejectAuthority("namespace-mismatch")
    if (intent.projectID !== doc.projectID || intent.projectCanonical !== doc.projectCanonical) rejectAuthority("binding-mismatch")
    const receipt = doc.receipts.find(item => item.requestID === intent.requestID) ?? null
    if (receipt && canonicalAuthority(bindingFromIntent(receipt.intent)) !== canonicalAuthority(bindingFromIntent(intent))) rejectAuthority("binding-mismatch")
    if (receipt && (receipt.digest !== digest || canonicalAuthority(receipt.intent) !== canonicalAuthority(intent))) rejectAuthority("request-conflict")
    if (receipt) await this.assertLifecycleCompletions(doc, intent.missionID)
    const result = JSON.parse(canonicalAuthority({ namespace: doc.namespace, projectID: doc.projectID,
      projectCanonical: doc.projectCanonical, receipt }, this.store.capacity.bytes)) as AuthorityReceiptRead
    // A detached immutable native result; wire decoding may be mutable, but it
    // can never alias persisted state. Do not synthesize a completion for pending.
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value) }
    }
    freeze(result)
    this.adapter.assertActive()
    return result
  }

  /** Reservations/metadata use the existing native project exclusion. Business
   * apply runs outside that lock: MissionControl takes it itself. Pending effects
   * are never automatically rerun, even on an exact signed retry. */
  async execute(input: unknown, effects: AuthorityEffectAdapter, signal: AbortSignal): Promise<AuthorityOperationResult> {
    const origin = effects.assertCurrent
    const current = (): true => {
      signal.throwIfAborted()
      if (origin) assertSynchronousAuthorityGuard(origin, "policy-unqualified")
      return true
    }
    current()
    this.adapter.assertActive()
    const verified = await this.authenticate(input)
    const { body } = verified
    await this.assertLifecycleCompletions(await this.store.read(), body.missionID)
    signal.throwIfAborted()
    const publicationSigner = verified.signer
    if (effects.expectedSigner) this.assertSameSigner(effects.expectedSigner, publicationSigner)
    const reserved = await this.store.transaction(async doc => {
      // Reverify against the current key map after waiting for project exclusion.
      const current = await this.authenticate(input)
      this.assertSameSigner(publicationSigner, current.signer)
      const signer = await this.assertTrust(body, doc)
      this.assertSameSigner(publicationSigner, snapshotAuthoritySigner(signer))
      const prior = doc.receipts.find(receipt => receipt.requestID === body.requestID)
      if (prior) {
        if (prior.digest !== authorityDigest(body)) rejectAuthority("request-conflict")
        return { fresh: false, ...this.result(doc, prior) }
      }
      await this.validate(body, doc)
      // Denial must remain publishable even if the business journal is full.
      // Stop/delete effects keep their own capacity checks; failed effects leave
      // honest pending receipts, never an enabled grant or a claimed interruption.
      const denies = body.method === "revoke" || body.method === "delete" || body.method === "lifecycle" && body.payload.action === "stop"
      try { if (!denies) await this.adapter.assertJournalCapacity(body) }
      catch (error) { if (error instanceof MissionAuthorityError) throw error; rejectAuthority("capacity") }
      signal.throwIfAborted()
      this.adapter.assertActive()
      const receipt: AuthorityReceipt = { requestID: body.requestID, digest: authorityDigest(body), intent: body,
        signerDigest: publicationSigner.signerDigest, provisioningGeneration: publicationSigner.provisioningGeneration }
      doc.receipts.push(receipt)
      this.reserveGrant(body, doc, signer)
      if (body.method === "adopt" || body.method === "revoke") {
        receipt.completion = { outcome: "applied", result: { metadataOnly: true } }
      }
      this.store.assertCapacity(doc)
      return { fresh: true, ...this.result(doc, receipt) }
    }, () => {
      this.adapter.assertActive(); signal.throwIfAborted()
      current()
      this.fenceSigner(publicationSigner)
    })
    if (!reserved.fresh || reserved.receipt.completion) return { receipt: reserved.receipt, grant: reserved.grant }
    if (body.method === "adopt" || body.method === "revoke") rejectAuthority("invalid-intent")
    // A crash/error after reservation is honest ambiguity. Do not mark rejected
    // or free quota: native effects may have happened despite a missing ACK.
    signal.throwIfAborted()
    await this.assertEffectReservation(body, current)
    let effectResult: AuthorityEffectResult
    try { effectResult = await effects.apply(body, signal) }
    catch (error) { if (error instanceof MissionAuthorityError) throw error; rejectAuthority("effect-unavailable") }
    current()
    return this.complete(body, effectResult, current)
  }

  /** Integration must reconcile ambiguous native receipts first. This is NOT an
   * RPC mutation or runner: only the trusted effect adapter can settle a proven
   * operation, with the original immutable intent/digest. It never replays work. */
  async complete(body: AuthorityEffectIntent, result: AuthorityEffectResult, assertCurrent?: () => true): Promise<AuthorityOperationResult> {
    if (assertCurrent) assertSynchronousAuthorityGuard(assertCurrent, "policy-unqualified")
    this.adapter.assertActive()
    canonicalAuthority(result, this.store.capacity.resultBytes)
    const parsed = authorityEffectResultSchema.safeParse(result)
    if (!parsed.success || !matchesAuthorityCompletion(body, { outcome: "applied", result })) rejectAuthority("invalid-intent")
    if (body.method === "lifecycle") {
      const observed = await this.observeMission(body.missionID)
      if (!observed || !matchesObservedLifecycle(body, result, observed)) rejectAuthority("observation-unavailable")
    }
    let publicationSigner: AuthoritySignerSnapshot | undefined
    return this.store.transaction(async doc => {
      publicationSigner = snapshotAuthoritySigner(await this.assertTrust(body, doc))
      const receipt = doc.receipts.find(item => item.requestID === body.requestID)
      if (!receipt || receipt.digest !== authorityDigest(body)) rejectAuthority("request-conflict")
      this.assertReceiptSigner(receipt, publicationSigner)
      if (receipt.completion) {
        if (canonicalAuthority(receipt.completion.result) !== canonicalAuthority(result)) rejectAuthority("request-conflict")
        return this.result(doc, receipt)
      }
      // A revoke/Stop supersedes pending Play; completion never restores its
      // historical grant. Require current journal state before enabling sends.
      const grant = doc.grants.find(item => item.missionID === body.missionID)
      if (body.method === "lifecycle" && body.payload.action === "start" && grant?.state === "active"
        && grant.epoch === body.epoch && !doc.terminals.some(item => item.missionID === body.missionID)) {
        const current = await this.observeMission(body.missionID)
        if (!current || current.status !== "active" || current.runState !== "running" || current.controlPending) rejectAuthority("authorization-blocked")
        this.assertObservation(body, current)
        grant.sendsEnabled = true
      }
      receipt.completion = { outcome: "applied", result: parsed.data }
      return this.result(doc, receipt)
    }, () => {
      this.adapter.assertActive()
      if (assertCurrent) assertSynchronousAuthorityGuard(assertCurrent, "policy-unqualified")
      if (!publicationSigner) rejectAuthority("untrusted-signer")
      this.fenceSigner(publicationSigner)
    })
  }

  async assertEffectReservation(body: AuthorityEffectIntent, assertCurrent?: () => true): Promise<void> {
    if (assertCurrent) assertSynchronousAuthorityGuard(assertCurrent, "policy-unqualified")
    this.adapter.assertActive()
    const observed = await this.observeMission(body.missionID)
    if (body.method !== "create") {
      if (!observed) rejectAuthority("authorization-blocked")
      this.assertObservation(body, observed)
      if (body.method === "recover" && (observed.status !== "active" || observed.runState !== "running" || observed.controlPending)) rejectAuthority("authorization-blocked")
      if (body.method === "lifecycle" && body.payload.action === "start" && observed.status !== "active") rejectAuthority("authorization-blocked")
    }
    const signers = await this.readSigners()
    const doc = await this.store.read()
    const signer = snapshotAuthoritySigner(this.assertTrustWithSigners(body, doc, signers))
    const receipt = doc.receipts.find(item => item.requestID === body.requestID)
    if (!receipt || receipt.digest !== authorityDigest(body) || receipt.completion) rejectAuthority("authorization-blocked")
    this.assertReceiptSigner(receipt, signer)
    if (doc.terminals.some(item => item.missionID === body.missionID)
      && !(body.method === "delete" || body.method === "lifecycle" && body.payload.action === "stop")) rejectAuthority("authorization-blocked")
    if (body.method === "lifecycle" && body.payload.action === "start" || body.method === "recover") {
      this.assertCurrentGrant(body, doc, body.method === "recover")
      if (doc.terminals.some(item => item.missionID === body.missionID)) rejectAuthority("authorization-blocked")
    }
    this.adapter.assertActive()
    this.fenceSigner(signer)
    if (assertCurrent) assertSynchronousAuthorityGuard(assertCurrent, "policy-unqualified")
  }

  /** Fresh native mirror check, not host-registry authority. Backend admission
   * must also verify its protected grant and hold its shared send/ownership gate. */
  async assertAdmission(binding: AuthorityBinding & { epoch: number; root: AuthorityRoot }): Promise<AuthorityGrant> {
    this.adapter.assertActive()
    const doc = await this.store.read()
    await this.assertTrust(binding, doc)
    const grant = this.assertCurrentGrant(binding, doc, true)
    if (!grant.roots.some(root => canonicalAuthority(root) === canonicalAuthority(binding.root))
      || doc.terminals.some(item => item.missionID === binding.missionID)
      || doc.receipts.some(receipt => receipt.intent.missionID === binding.missionID && !receipt.completion)) rejectAuthority("authorization-blocked")
    const observation = await this.observeMission(binding.missionID)
    if (!observation || observation.status !== "active" || observation.runState !== "running" || observation.controlPending) rejectAuthority("authorization-blocked")
    this.assertObservation(binding, observation)
    // Do not return a cached grant across observation/provisioning awaits.
    const signers = await this.readSigners()
    const fresh = await this.store.read()
    const signer = snapshotAuthoritySigner(this.assertTrustWithSigners(binding, fresh, signers))
    const current = this.assertCurrentGrant(binding, fresh, true)
    if (fresh.terminals.some(item => item.missionID === binding.missionID)
      || fresh.receipts.some(receipt => receipt.intent.missionID === binding.missionID && !receipt.completion)) rejectAuthority("authorization-blocked")
    this.adapter.assertActive()
    this.fenceSigner(signer)
    return current
  }

  private async authenticate(input: unknown) {
    return authenticateAuthorityIntent(input, await this.readSigners())
  }
  private async assertLifecycleCompletions(doc: AuthorityDocument, missionID: string): Promise<void> {
    const completed = doc.receipts.filter(receipt => receipt.intent.missionID === missionID
      && receipt.intent.method === "lifecycle" && receipt.completion?.outcome === "applied")
    if (!completed.length) return
    const observed = await this.observeMission(missionID)
    // Historical lifecycle evidence remains readable after an accepted map
    // deletion; the deleted terminal does not settle any outstanding receipt.
    if (!observed && doc.terminals.some(item => item.missionID === missionID && item.state === "deleted")) return
    if (!observed || observed.controlUnavailable) rejectAuthority("storage-invalid")
    for (const receipt of completed) {
      const result = authorityEffectResultSchema.parse(receipt.completion!.result)
      if (observed.control?.id === result.operationID) {
        if (!matchesObservedLifecycle(receipt.intent, result, observed)) rejectAuthority("storage-invalid")
      } else if (!observed.control || result.revision! > observed.control.expectedRevision || result.revision! > observed.revision) {
        rejectAuthority("storage-invalid")
      }
    }
  }
  private assertReceiptSigner(receipt: AuthorityReceipt, signer: AuthoritySignerSnapshot): void {
    if (receipt.signerDigest !== signer.signerDigest || receipt.provisioningGeneration !== signer.provisioningGeneration) rejectAuthority("untrusted-signer")
  }
  private assertSameSigner(expected: AuthoritySignerSnapshot, actual: AuthoritySignerSnapshot): void {
    if (expected.signerDigest !== actual.signerDigest || expected.provisioningGeneration !== actual.provisioningGeneration
      || canonicalAuthority(expected.roots) !== canonicalAuthority(actual.roots)) rejectAuthority("untrusted-signer")
    for (const key of ["authorityID", "keyID", "profileID", "executionHost", "namespace", "projectID", "projectCanonical", "policy", "qualification"] as const) {
      if (expected[key] !== actual[key]) rejectAuthority("untrusted-signer")
    }
  }
  private fenceSigner(signer: AuthoritySignerSnapshot): void {
    assertSynchronousAuthorityGuard(() => this.adapter.assertSignerCurrent(signer), "trust-unavailable")
  }
  private async assertTrust(binding: AuthorityBinding, doc: AuthorityDocument): Promise<ProvisionedAuthoritySigner> {
    return this.assertTrustWithSigners(binding, doc, await this.readSigners())
  }
  private assertTrustWithSigners(binding: AuthorityBinding, doc: AuthorityDocument,
    signers: readonly ProvisionedAuthoritySigner[]): ProvisionedAuthoritySigner {
    if (binding.namespace !== doc.namespace) rejectAuthority("namespace-mismatch")
    if (binding.projectID !== doc.projectID || binding.projectCanonical !== doc.projectCanonical) rejectAuthority("binding-mismatch")
    const signer = selectProvisionedSigner(binding, signers)
    if (signer.policy !== MISSION_AUTHORITY_POLICY || signer.qualification !== "qualified"
      || signer.publicKey.type !== "public" || signer.publicKey.asymmetricKeyType !== "ed25519") rejectAuthority("policy-unqualified")
    assertAuthorityScope(binding, signer)
    const grant = doc.grants.find(item => item.missionID === binding.missionID)
    if (grant?.state === "active" && grant.authorityID === signer.authorityID && grant.keyID === signer.keyID
      && grant.signerDigest !== authoritySignerDigest(signer.publicKey)) rejectAuthority("untrusted-signer")
    return signer
  }
  private async validate(body: AuthorityIntent, doc: AuthorityDocument): Promise<void> {
    const mission = await this.observeMission(body.missionID)
    const terminal = doc.terminals.some(item => item.missionID === body.missionID)
    const grant = doc.grants.find(item => item.missionID === body.missionID)
    if (body.method === "create") {
      if (mission || grant || terminal || body.expectedRevision !== 0 || body.epoch !== 0
        || doc.receipts.some(item => item.intent.missionID === body.missionID)) rejectAuthority("revision-conflict")
      return
    }
    if (!mission || mission.revision !== body.expectedRevision) rejectAuthority("revision-conflict")
    this.assertObservation(body, mission)
    if (body.method === "adopt") {
      if (terminal || mission.status !== "active" || mission.runState === "stopped" || mission.controlPending) rejectAuthority("authorization-blocked")
      if (body.epoch !== (grant?.epoch ?? 0) + 1) rejectAuthority("epoch-conflict")
      // Another active profile/signer cannot silently replace the owner.
      if (grant?.state === "active") this.assertSameGrant(body, grant, false)
    } else {
      if (body.epoch !== (grant?.epoch ?? 0)) rejectAuthority("epoch-conflict")
      if (grant) this.assertSameGrant(body, grant, false)
      if (body.method === "recover" || body.method === "lifecycle" && body.payload.action === "start") {
        this.assertCurrentGrant(body, doc, body.method === "recover")
        if (terminal || mission.status !== "active" || mission.controlPending) rejectAuthority("authorization-blocked")
      }
    }
    const pending = doc.receipts.some(item => item.intent.missionID === body.missionID && !item.completion)
    const supersedes = body.method === "revoke" || body.method === "delete" || body.method === "lifecycle" && body.payload.action === "stop"
    if (pending && !supersedes) rejectAuthority("authorization-blocked")
    if (terminal && !supersedes) rejectAuthority("authorization-blocked")
  }
  private assertObservation(binding: AuthorityBinding, mission: AuthorityMissionObservation): void {
    if (mission.missionID !== binding.missionID || mission.coordinatorSessionID !== binding.coordinatorSessionID
      || canonicalAuthority(mission.roots) !== canonicalAuthority(binding.roots)) rejectAuthority("binding-mismatch")
  }
  private reserveGrant(body: AuthorityIntent, doc: AuthorityDocument, signer: ProvisionedAuthoritySigner): void {
    const grant = doc.grants.find(item => item.missionID === body.missionID)
    if (body.method === "adopt") {
      const adopted: AuthorityGrant = { ...bindingFromIntent(body), version: 1, epoch: body.epoch,
        signerDigest: authoritySignerDigest(signer.publicKey), state: "active", sendsEnabled: false }
      if (grant) doc.grants[doc.grants.indexOf(grant)] = adopted
      else doc.grants.push(adopted)
    }
    if (body.method === "revoke" || body.method === "delete" || body.method === "lifecycle") {
      if (grant) grant.sendsEnabled = false
      if (grant && (body.method !== "lifecycle" || body.payload.action === "stop")) grant.state = "revoked"
    }
    if (body.method === "delete" || body.method === "lifecycle" && body.payload.action === "stop") {
      const existing = doc.terminals.find(item => item.missionID === body.missionID)
      if (!existing) doc.terminals.push({ missionID: body.missionID, state: body.method === "delete" ? "deleted" : "stopped" })
      else if (body.method === "delete") existing.state = "deleted"
    }
  }
  private assertCurrentGrant(binding: AuthorityBinding & { epoch: number }, doc: AuthorityDocument, sends: boolean): AuthorityGrant {
    const grant = doc.grants.find(item => item.missionID === binding.missionID)
    if (!grant || grant.state !== "active" || (sends && !grant.sendsEnabled)) rejectAuthority("authorization-blocked")
    this.assertSameGrant(binding, grant, true)
    return grant
  }
  private assertSameGrant(binding: AuthorityBinding & { epoch: number }, grant: AuthorityGrant, epoch: boolean): void {
    assertAuthorityScope(binding, grant)
    if (binding.missionID !== grant.missionID || binding.coordinatorSessionID !== grant.coordinatorSessionID) rejectAuthority("binding-mismatch")
    if (epoch && binding.epoch !== grant.epoch) rejectAuthority("epoch-conflict")
  }
  private result(doc: AuthorityDocument, receipt: AuthorityReceipt): AuthorityOperationResult {
    // Detach returned objects from the mutable transaction document.
    return JSON.parse(JSON.stringify({ receipt, grant: doc.grants.find(item => item.missionID === receipt.intent.missionID) ?? null }))
  }
  private async readSigners(): Promise<readonly ProvisionedAuthoritySigner[]> {
    try { return await this.adapter.readSigners() } catch { return rejectAuthority("trust-unavailable") }
  }
  private async observeMission(missionID: string): Promise<AuthorityMissionObservation | undefined> {
    try { return await this.adapter.observeMission(missionID) } catch { return rejectAuthority("observation-unavailable") }
  }
}
