import { canonicalAuthority, rejectAuthority, type AuthoritySignerSnapshot, type ProvisionedAuthoritySigner } from "./authority-protocol"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { parseRecurrenceDocument, type RecurrenceDocument } from "./recurrence-contract"
import { authenticateRecurrenceStanding, assertRecurrenceEffectScope, deriveRecurrenceChild, recurrenceAuthorityDigest, recurrenceEffectID, recurrenceEffectReceiptSchema,
  recurrenceEffectSchema, recurrenceSettlementSchema, type RecurrenceAuthorityArchive, type RecurrenceAuthorityScope,
  type RecurrenceChildGrant, type RecurrenceChildRecord, type RecurrenceEffectReceipt,
  type RecurrenceEffectRecord, type RecurrenceSettlement, type SignedRecurrenceStandingIntent,
  RECURRENCE_AUTHORITY_MAX_BYTES, RECURRENCE_QUALIFICATION_MAX_BYTES } from "./recurrence-authority-contract"
import { NativeRecurrenceAuthorityStore, type RecurrenceAuthorityDocument } from "./recurrence-authority-store"

export interface RecurrenceQualificationRequest {
  purpose: "human" | "reserve" | "effect" | "receipt" | "settle"
  scope: Readonly<RecurrenceAuthorityScope>
  ledger: Readonly<RecurrenceAuthorityDocument> | null
  parent: Readonly<SignedRecurrenceStandingIntent>
  document?: Readonly<RecurrenceDocument>
  effect?: Readonly<RecurrenceEffectRecord>
  settlement?: Readonly<RecurrenceSettlement>
}
export interface RecurrenceQualificationLease { readonly requestDigest: string; assertCurrent(): true }
/** Trusted construction dependency, NOT RPC/options. No production proof issuer.
 * qualify authenticates sustained native-parent/writer/family/storage identity,
 * the protected signed human reservation, or the exact actual stored passage,
 * invocation/target/payload/native receipts appropriate to purpose. It must reject
 * ledger rollback. assertLedgerCurrent synchronously rereads THIS native ledger
 * under that claim, never a UI/process cache. Effect leases exclude competing
 * writers through the immediate original native invocation. */
export interface RecurrenceAuthorityAdapter {
  readSigners(): Promise<readonly ProvisionedAuthoritySigner[]>
  assertSignerCurrent(signer: AuthoritySignerSnapshot): true
  qualify(request: Readonly<RecurrenceQualificationRequest>, signal: AbortSignal): Promise<RecurrenceQualificationLease>
  assertLedgerCurrent(store: NativeRecurrenceAuthorityStore, expected: Readonly<RecurrenceAuthorityDocument> | null): true
  /** Fresh actual invocation/target/payload, non-archived-child AND no pending
   * next-epoch parent archive (especially denial), immediately before native
   * entry. A matching live ledger alone is not execution authority. */
  assertEffectCurrent(store: NativeRecurrenceAuthorityStore, child: Readonly<RecurrenceChildRecord>, operation: Readonly<RecurrenceEffectRecord>): true
  observeEffect(child: Readonly<RecurrenceChildRecord>, operation: Readonly<RecurrenceEffectRecord>, signal: AbortSignal): Promise<{
    receipt: RecurrenceEffectReceipt; assertCurrent(): true
  }>
  /** Actual terminal/no-effect evidence AND full idle/control/notification/child
   * call settlement, not admission ACK/model prose. IDs/receipts are stable. */
  observeSettlement(child: Readonly<RecurrenceChildRecord>, signal: AbortSignal): Promise<{
    settlement: RecurrenceSettlement; assertCurrent(): true
  }>
}
const equal = (a: unknown, b: unknown) => canonicalAuthority(a, RECURRENCE_AUTHORITY_MAX_BYTES) === canonicalAuthority(b, RECURRENCE_AUTHORITY_MAX_BYTES)
const copy = <T>(value: T): T => JSON.parse(canonicalAuthority(value, RECURRENCE_AUTHORITY_MAX_BYTES))
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

/** Typed recurrence publisher only. Never human.sign, raw native execution,
 * permission auto-approval, timers, namespace creation or ordinary authority GC. */
export class RecurrenceAuthority {
  constructor(readonly store: NativeRecurrenceAuthorityStore, private readonly adapter: RecurrenceAuthorityAdapter) {
    if (!adapter || ["readSigners", "assertSignerCurrent", "qualify", "assertLedgerCurrent", "assertEffectCurrent", "observeEffect", "observeSettlement"]
      .some(key => typeof adapter[key as keyof RecurrenceAuthorityAdapter] !== "function")) rejectAuthority("policy-unqualified")
  }
  async authorize(input: unknown, signal: AbortSignal): Promise<RecurrenceAuthorityDocument> {
    const verified = await this.authenticate(input, signal), signed = verified.signed, body = signed.body
    return this.store.transaction(body.expectedRevision, async before => {
      if (before?.parent.body.action === "revoke" || body.action === "authorize" && before?.child) rejectAuthority("authorization-blocked")
      if (body.epoch !== (before?.parent.body.epoch ?? 0) + 1 || !before && body.action !== "authorize"
        || before && body.scheduleRevision < before.parent.body.scheduleRevision
        || before && body.action !== "authorize" && (body.scheduleRevision !== before.parent.body.scheduleRevision
          || !equal(body.config, before.parent.body.config) || !equal(body.budgets, before.parent.body.budgets))) rejectAuthority("epoch-conflict")
      // An archive-only tear may reconcile this EXACT signed decision with fresh
      // protected human admission; a different intent never borrows its epoch.
      const archived = await this.store.readParent(body.epoch)
      if (archived && !equal(archived, signed)) rejectAuthority("request-conflict")
      const lease = await this.qualify({ purpose: "human", parent: signed, ledger: before ?? null }, signal)
      const current = this.current(before, verified.signer, lease, signal)
      await this.store.archiveParent(signed, current)
      const document: RecurrenceAuthorityDocument = { version: 1, scope: { ...this.store.scope },
        revision: before ? before.revision + 1 : 0, parent: signed, settledSequence: before?.settledSequence ?? 0,
        lastArchiveDigest: before?.lastArchiveDigest ?? null, child: before?.child ?? null }
      return { document, result: copy(document), assertCurrent: current }
    })
  }
  async reservePassage(raw: Readonly<RecurrenceDocument>, expectedRevision: number, signal: AbortSignal): Promise<RecurrenceChildGrant> {
    return this.store.transaction(expectedRevision, async before => {
      const doc = this.running(before), verified = await this.authenticate(doc.parent, signal)
      await this.noPendingParent(doc)
      if (doc.child) rejectAuthority("authorization-blocked")
      const source = parseRecurrenceDocument(raw, this.store.scope.projectID, this.store.scope.projectCanonical, this.store.scope.scheduleID)
      const grant = deriveRecurrenceChild(verified.signed, source, doc.settledSequence + 1)
      if (await this.store.readPassage(grant.passage.id)) rejectAuthority("authorization-blocked")
      const lease = await this.qualify({ purpose: "reserve", parent: doc.parent, ledger: doc, document: source }, signal)
      const document = copy(doc)
      document.revision++; document.child = { parent: verified.signed, grant, effects: [] }
      return { document, result: copy(grant), assertCurrent: this.current(doc, verified.signer, lease, signal) }
    })
  }
  /** Reservation is durable BEFORE returning a single-use effect fence. Throw or
   * lost reply parks/charges the original operation; this never dispatches/replays. */
  async reserveEffect(grantID: string, input: unknown, expectedRevision: number, signal: AbortSignal): Promise<{
    grant: Readonly<RecurrenceChildGrant>; operation: Readonly<RecurrenceEffectRecord>; assertCurrent(): true
  }> {
    canonicalAuthority(input)
    const parsed = recurrenceEffectSchema.safeParse(input)
    if (!parsed.success) rejectAuthority("invalid-intent")
    const effect = parsed.data
    const published = await this.store.transaction(expectedRevision, async before => {
      const doc = this.running(before), child = this.child(doc, grantID), verified = await this.authenticate(doc.parent, signal)
      await this.noPendingParent(doc)
      if (!equal(child.parent, doc.parent)) rejectAuthority("epoch-conflict")
      if (await this.store.readPassage(child.grant.passage.id)) rejectAuthority("authorization-blocked")
      assertRecurrenceEffectScope(child, effect)
      const operation: RecurrenceEffectRecord = { operationID: recurrenceEffectID(child.grant, effect), effect, receipt: null }
      if (child.effects.some(previous => previous.operationID === operation.operationID)) rejectAuthority("request-conflict")
      const lease = await this.qualify({ purpose: "effect", parent: doc.parent, ledger: doc, effect: operation }, signal)
      const document = copy(doc)
      document.revision++; document.child!.effects.push(operation)
      return { document, result: { document, operation }, assertCurrent: this.current(doc, verified.signer, lease, signal) }
    })
    // Requalify the exact PUBLISHED reservation; a post-write failure remains
    // unknown. Nothing creates a second operation or a fresh execution lease.
    const verified = await this.authenticate(published.document.parent, signal)
    const lease = await this.qualify({ purpose: "effect", parent: published.document.parent,
      ledger: published.document, effect: published.operation }, signal)
    const current = this.current(published.document, verified.signer, lease, signal)
    let consumed = false
    return { grant: freeze(copy(published.document.child!.grant)), operation: freeze(copy(published.operation)), assertCurrent: () => {
      if (consumed) rejectAuthority("authorization-blocked")
      consumed = true // Reentrancy/failure cannot produce a replacement approval.
      current()
      assertSynchronousAuthorityGuard(() => this.adapter.assertEffectCurrent(this.store,
        freeze(copy(published.document.child!)), freeze(copy(published.operation))), "policy-unqualified")
      return true
    } }
  }
  /** Positive authenticated native receipt only. Caller supplies no outcome. */
  async acknowledgeEffect(grantID: string, operationID: string, expectedRevision: number, signal: AbortSignal): Promise<RecurrenceEffectReceipt> {
    return this.store.transaction(expectedRevision, async before => {
      if (!before) rejectAuthority("authorization-blocked")
      await this.noPendingParent(before)
      const child = this.child(before, grantID), operation = child.effects.find(item => item.operationID === operationID)
      if (!operation || operation.receipt) rejectAuthority("request-conflict")
      const observed = await this.adapter.observeEffect(freeze(copy(child)), freeze(copy(operation)), signal)
      canonicalAuthority(observed.receipt)
      const receipt = recurrenceEffectReceiptSchema.parse(observed.receipt)
      if (receipt.operationID !== operationID) rejectAuthority("binding-mismatch")
      const lease = await this.qualify({ purpose: "receipt", parent: child.parent, ledger: before, effect: { ...operation, receipt } }, signal)
      const current = this.evidenceCurrent(before, lease, observed.assertCurrent.bind(observed), signal)
      const document = copy(before)
      document.revision++; document.child!.effects.find(item => item.operationID === operationID)!.receipt = receipt
      return { document, result: copy(receipt), assertCurrent: current }
    })
  }
  /** Archive-only recovery is safe: repeated settlement may reconcile metadata
   * with original stable native evidence, but never returns an execution fence. */
  async settle(grantID: string, expectedRevision: number, signal: AbortSignal): Promise<RecurrenceAuthorityArchive> {
    return this.store.transaction(expectedRevision, async before => {
      if (!before) rejectAuthority("authorization-blocked")
      await this.noPendingParent(before)
      const child = this.child(before, grantID)
      const observed = await this.adapter.observeSettlement(freeze(copy(child)), signal)
      canonicalAuthority(observed.settlement)
      const settlement = recurrenceSettlementSchema.parse(observed.settlement)
      if (settlement.grantID !== grantID || settlement.effects.length !== child.effects.length
        || new Set(settlement.effects.map(item => item.operationID)).size !== settlement.effects.length) rejectAuthority("binding-mismatch")
      const settled = copy(child)
      for (const operation of settled.effects) {
        const receipt = settlement.effects.find(item => item.operationID === operation.operationID)
        if (!receipt || operation.receipt && !equal(receipt, operation.receipt)) rejectAuthority("request-conflict")
        operation.receipt = receipt
      }
      const lease = await this.qualify({ purpose: "settle", parent: child.parent, ledger: before, settlement }, signal)
      const current = this.evidenceCurrent(before, lease, observed.assertCurrent.bind(observed), signal)
      const archive: RecurrenceAuthorityArchive = { version: 1, child: settled, settlement, previousArchiveDigest: before.lastArchiveDigest }
      // Unknown ACKs may reconcile from this exact positive terminal observation;
      // archived immutable claims/previous receipts must still match hot state.
      await this.store.archiveChild(archive, current)
      const document = copy(before)
      document.revision++; document.child = null; document.settledSequence++
      document.lastArchiveDigest = recurrenceAuthorityDigest(archive)
      return { document, result: copy(archive), assertCurrent: current }
    })
  }
  private async noPendingParent(doc: RecurrenceAuthorityDocument): Promise<void> {
    if (await this.store.readParent(doc.parent.body.epoch + 1)) rejectAuthority("authorization-blocked")
  }
  private running(doc: RecurrenceAuthorityDocument | undefined): RecurrenceAuthorityDocument {
    if (!doc || doc.parent.body.action !== "authorize") rejectAuthority("authorization-blocked")
    return doc
  }
  private child(doc: RecurrenceAuthorityDocument, grantID: string): RecurrenceChildRecord {
    if (!doc.child || doc.child.grant.grantID !== grantID) rejectAuthority("binding-mismatch")
    return doc.child
  }
  private async authenticate(input: unknown, signal: AbortSignal) {
    signal.throwIfAborted()
    const result = authenticateRecurrenceStanding(input, await this.adapter.readSigners())
    signal.throwIfAborted()
    assertSynchronousAuthorityGuard(() => this.adapter.assertSignerCurrent(result.signer), "untrusted-signer")
    return result
  }
  private async qualify(input: Omit<RecurrenceQualificationRequest, "scope">, signal: AbortSignal): Promise<RecurrenceQualificationLease> {
    const request = freeze(JSON.parse(canonicalAuthority({ ...input, scope: { ...this.store.scope } }, RECURRENCE_QUALIFICATION_MAX_BYTES)) as RecurrenceQualificationRequest)
    signal.throwIfAborted()
    const lease = await this.adapter.qualify(request, signal)
    if (!lease || lease.requestDigest !== recurrenceQualificationDigest(request)) rejectAuthority("policy-unqualified")
    assertSynchronousAuthorityGuard(() => lease.assertCurrent(), "policy-unqualified")
    return Object.freeze({ requestDigest: lease.requestDigest, assertCurrent: lease.assertCurrent.bind(lease) })
  }
  private current(doc: RecurrenceAuthorityDocument | undefined, signer: AuthoritySignerSnapshot,
    lease: RecurrenceQualificationLease, signal: AbortSignal): () => true {
    const evidence = this.evidenceCurrent(doc, lease, () => this.adapter.assertSignerCurrent(signer), signal)
    return evidence
  }
  private evidenceCurrent(doc: RecurrenceAuthorityDocument | undefined, lease: RecurrenceQualificationLease,
    observed: () => true, signal: AbortSignal): () => true {
    const pinned = doc ? freeze(copy(doc)) : null
    return () => {
      signal.throwIfAborted()
      assertSynchronousAuthorityGuard(() => lease.assertCurrent(), "policy-unqualified")
      assertSynchronousAuthorityGuard(observed, "policy-unqualified")
      return assertSynchronousAuthorityGuard(() => this.adapter.assertLedgerCurrent(this.store, pinned), "policy-unqualified")
    }
  }
}

export function recurrenceQualificationDigest(request: Readonly<RecurrenceQualificationRequest>): string {
  return recurrenceAuthorityDigest(request, RECURRENCE_QUALIFICATION_MAX_BYTES)
}
