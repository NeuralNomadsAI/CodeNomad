import { z } from "zod"
import { canonicalAuthority, rejectAuthority } from "./authority-protocol"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "./authority-store"
import { runMissionExclusive } from "./exclusive"
import { stableToken, type MissionStorage } from "./journal"
import { assertRecurrenceChild, assertRecurrenceEffectScope, recurrenceAuthorityDigest, recurrenceAuthorityArchiveSchema, recurrenceAuthorityScopeSchema, recurrenceChildRecordSchema,
  recurrenceEffectID, signedRecurrenceStandingIntentSchema, RECURRENCE_AUTHORITY_MAX_BYTES,
  type RecurrenceAuthorityArchive, type RecurrenceAuthorityScope, type RecurrenceChildRecord, type SignedRecurrenceStandingIntent } from "./recurrence-authority-contract"

const counter = z.number().int().nonnegative().safe()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const recurrenceAuthorityDocumentSchema = z.object({ version: z.literal(1), scope: recurrenceAuthorityScopeSchema,
  revision: counter, parent: signedRecurrenceStandingIntentSchema, settledSequence: counter,
  lastArchiveDigest: digest.nullable(), child: recurrenceChildRecordSchema.nullable() }).strict()
export type RecurrenceAuthorityDocument = z.infer<typeof recurrenceAuthorityDocumentSchema>
const same = (left: unknown, right: unknown) => canonicalAuthority(left, RECURRENCE_AUTHORITY_MAX_BYTES) === canonicalAuthority(right, RECURRENCE_AUTHORITY_MAX_BYTES)

/** Exact-key native metadata, never an alternate authority namespace or a
 * passage-journal adapter. No scans, deletion or disk-bound claim. get/set is NOT
 * CAS: every mutation additionally needs the genuine protected writer fence. */
export class NativeRecurrenceAuthorityStore {
  readonly scope: Readonly<RecurrenceAuthorityScope>
  readonly projectToken: string
  readonly parentKey: string
  readonly key: string
  constructor(private readonly storage: MissionStorage, scope: RecurrenceAuthorityScope) {
    this.scope = Object.freeze(recurrenceAuthorityScopeSchema.parse(JSON.parse(canonicalAuthority(scope))))
    this.projectToken = stableToken(`${scope.projectID}\0${scope.projectCanonical}`, 24)
    this.parentKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/recurrence/${this.projectToken}/${stableToken(`${scope.profileID}\0${scope.executionHost}\0${scope.scheduleID}`, 40)}`
    this.key = `${this.parentKey}/live`
  }
  async read(): Promise<RecurrenceAuthorityDocument | undefined> {
    await this.namespace()
    const raw = await this.get(this.key)
    const doc = raw === undefined ? undefined : this.parse(raw)
    if (doc) {
      const parent = await this.readParent(doc.parent.body.epoch)
      if (!parent || !same(parent, doc.parent)) rejectAuthority("storage-invalid")
      // An archive/hot tear is evidence-only. The core refuses new effects;
      // exact retirement may finish bookkeeping without replaying execution.
      if (doc.settledSequence) {
        const last = await this.get(`${this.parentKey}/settled/${doc.settledSequence}`)
        if (last !== doc.lastArchiveDigest) rejectAuthority("storage-invalid")
      }
    }
    await this.namespace()
    return doc
  }
  async readParent(epoch: number): Promise<SignedRecurrenceStandingIntent | undefined> {
    if (!Number.isSafeInteger(epoch) || epoch < 1) rejectAuthority("invalid-intent")
    const raw = await this.get(`${this.parentKey}/parents/${epoch}`)
    if (raw === undefined) return undefined
    canonicalAuthority(raw)
    const parsed = signedRecurrenceStandingIntentSchema.safeParse(raw)
    if (!parsed.success || parsed.data.body.epoch !== epoch) rejectAuthority("storage-invalid")
    this.assertScope(parsed.data.body)
    return parsed.data
  }
  async readPassage(id: string): Promise<RecurrenceAuthorityArchive | undefined> {
    if (!/^[A-Za-z0-9_-]{3,100}$/.test(id)) rejectAuthority("invalid-intent")
    const raw = await this.get(`${this.parentKey}/passages/${id}`)
    if (raw === undefined) return undefined
    canonicalAuthority(raw, RECURRENCE_AUTHORITY_MAX_BYTES)
    const parsed = recurrenceAuthorityArchiveSchema.safeParse(raw)
    if (!parsed.success || parsed.data.child.grant.passage.id !== id) rejectAuthority("storage-invalid")
    this.assertChild(parsed.data.child)
    this.assertSettlement(parsed.data)
    await this.assertArchiveCommit(parsed.data)
    return parsed.data
  }
  async archiveParent(parent: SignedRecurrenceStandingIntent, fence: () => true): Promise<void> {
    this.assertScope(parent.body)
    await this.immutable(`${this.parentKey}/parents/${parent.body.epoch}`, parent, fence)
  }
  async archiveChild(archive: RecurrenceAuthorityArchive, fence: () => true): Promise<void> {
    this.assertChild(archive.child); this.assertSettlement(archive)
    await this.assertArchiveCommit(archive)
    await this.immutable(`${this.parentKey}/passages/${archive.child.grant.passage.id}`, archive, fence)
    await this.immutable(`${this.parentKey}/settled/${archive.child.grant.sequence}`, recurrenceAuthorityDigest(archive), fence)
  }
  transaction<T>(expectedRevision: number | null, operation: (before: RecurrenceAuthorityDocument | undefined) => Promise<{
    document: RecurrenceAuthorityDocument; result: T; assertCurrent(): true
  }>): Promise<T> {
    return runMissionExclusive(`mutation:${this.projectToken}`, async () => {
      const before = await this.read()
      if ((before?.revision ?? null) !== expectedRevision) rejectAuthority("revision-conflict")
      const prepared = await operation(before && structuredClone(before)), next = this.parse(prepared.document)
      await this.monotonic(before, next)
      // Reserve receipt/terminal room only when adding a child or effect. Positive
      // receipts and denial/retirement bookkeeping may consume that reserved room.
      if (next.child && (!before?.child || next.child.effects.length > before.child.effects.length)) {
        canonicalAuthority(next, RECURRENCE_AUTHORITY_MAX_BYTES - 64 * 1024)
      }
      const parent = await this.readParent(next.parent.body.epoch)
      if (!parent || !same(parent, next.parent)) rejectAuthority("storage-invalid")
      // Archive may already exist after a failed hot publication; it denies new
      // effects but permits only this exact original retirement bookkeeping.
      const raw = await this.get(this.key)
      if (!same(raw ?? null, before ?? null)) rejectAuthority("revision-conflict")
      await this.namespace()
      const fence = () => assertSynchronousAuthorityGuard(() => prepared.assertCurrent(), "policy-unqualified")
      fence()
      await this.set(this.key, next, fence)
      const saved = await this.get(this.key)
      if (!same(saved ?? null, next)) rejectAuthority("storage-unavailable")
      await this.namespace()
      return prepared.result
    })
  }
  private parse(raw: unknown): RecurrenceAuthorityDocument {
    canonicalAuthority(raw, RECURRENCE_AUTHORITY_MAX_BYTES)
    const parsed = recurrenceAuthorityDocumentSchema.safeParse(raw)
    if (!parsed.success) rejectAuthority("storage-invalid")
    const doc = parsed.data
    if (!same(doc.scope, this.scope) || (doc.settledSequence === 0) !== (doc.lastArchiveDigest === null)) rejectAuthority("storage-invalid")
    this.assertScope(doc.parent.body)
    if (doc.child) {
      this.assertChild(doc.child)
      if (doc.child.grant.sequence !== doc.settledSequence + 1 || doc.child.parent.body.epoch > doc.parent.body.epoch) rejectAuthority("storage-invalid")
    }
    return doc
  }
  private assertScope(value: RecurrenceAuthorityScope): void {
    for (const key of Object.keys(this.scope) as (keyof RecurrenceAuthorityScope)[]) {
      if (value[key] !== this.scope[key]) rejectAuthority("binding-mismatch")
    }
  }
  private assertChild(child: RecurrenceChildRecord): void {
    this.assertScope(child.parent.body); assertRecurrenceChild(child.parent, child.grant)
    if (child.parent.body.action !== "authorize" || child.effects.length > child.parent.body.budgets.effects
      || new Set(child.effects.map(effect => effect.operationID)).size !== child.effects.length) rejectAuthority("storage-invalid")
    const prefix: RecurrenceChildRecord = { parent: child.parent, grant: child.grant, effects: [] }
    for (const effect of child.effects) {
      assertRecurrenceEffectScope(prefix, effect.effect)
      if (effect.operationID !== recurrenceEffectID(child.grant, effect.effect)
        || effect.receipt && effect.receipt.operationID !== effect.operationID) rejectAuthority("storage-invalid")
      prefix.effects.push(effect)
    }
  }
  private assertSettlement(archive: RecurrenceAuthorityArchive): void {
    const { child, settlement } = archive
    if (settlement.grantID !== child.grant.grantID || settlement.effects.length !== child.effects.length
      || new Set(settlement.effects.map(effect => effect.operationID)).size !== settlement.effects.length
      || child.effects.some(effect => !effect.receipt || !settlement.effects.some(receipt => same(receipt, effect.receipt)))
      || settlement.outcome === "rejected-before-effect" && settlement.effects.some(effect => effect.outcome !== "rejected-before-effect")) rejectAuthority("storage-invalid")
  }
  private async assertArchiveCommit(archive: RecurrenceAuthorityArchive): Promise<void> {
    const committed = await this.get(`${this.parentKey}/settled/${archive.child.grant.sequence}`)
    // Absence is valid only as uncommitted archive evidence; exact-byte immutable
    // publication still governs tear recovery. An existing commitment must match.
    if (committed !== undefined && committed !== recurrenceAuthorityDigest(archive)) rejectAuthority("storage-invalid")
  }
  private async monotonic(before: RecurrenceAuthorityDocument | undefined, next: RecurrenceAuthorityDocument): Promise<void> {
    if (!before) {
      if (next.revision !== 0 || next.settledSequence !== 0 || next.child || next.parent.body.epoch !== 1
        || next.parent.body.expectedRevision !== null || next.parent.body.action !== "authorize") rejectAuthority("request-conflict")
      return
    }
    if (next.revision !== before.revision + 1) rejectAuthority("revision-conflict")
    const changed = !same(before.parent, next.parent)
    if (changed) {
      if (before.parent.body.action === "revoke" || next.parent.body.expectedRevision !== before.revision
        || next.parent.body.epoch !== before.parent.body.epoch + 1 || before.child && next.parent.body.action === "authorize"
        || !same(before.child, next.child) || next.settledSequence !== before.settledSequence
        || next.parent.body.action !== "authorize" && (!same(before.parent.body.config, next.parent.body.config)
          || !same(before.parent.body.budgets, next.parent.body.budgets) || before.parent.body.scheduleRevision !== next.parent.body.scheduleRevision)) rejectAuthority("authorization-blocked")
    }
    if (before.child && !next.child) {
      const archive = await this.readPassage(before.child.grant.passage.id)
      if (!archive || !same(archive.child.parent, before.child.parent) || !same(archive.child.grant, before.child.grant)
        || archive.child.effects.length !== before.child.effects.length
        || before.child.effects.some((old, index) => {
          const current = archive.child.effects[index]
          return old.operationID !== current.operationID || !same(old.effect, current.effect)
            || !!old.receipt && !same(old.receipt, current.receipt)
        }) || archive.previousArchiveDigest !== before.lastArchiveDigest
        || next.settledSequence !== before.settledSequence + 1 || next.lastArchiveDigest !== recurrenceAuthorityDigest(archive)) rejectAuthority("request-conflict")
    } else {
      if (next.settledSequence !== before.settledSequence || next.lastArchiveDigest !== before.lastArchiveDigest) rejectAuthority("request-conflict")
      if (!before.child && next.child && (!same(next.child.parent, before.parent) || next.child.effects.length
        || before.parent.body.action !== "authorize" || await this.readPassage(next.child.grant.passage.id))) rejectAuthority("authorization-blocked")
      if (before.child && next.child) {
        if (!same(before.child.parent, next.child.parent) || !same(before.child.grant, next.child.grant)
          || next.child.effects.length < before.child.effects.length || next.child.effects.length > before.child.effects.length + 1) rejectAuthority("request-conflict")
        for (let index = 0; index < before.child.effects.length; index++) {
          const old = before.child.effects[index], current = next.child.effects[index]
          if (old.operationID !== current.operationID || !same(old.effect, current.effect)
            || old.receipt && !same(old.receipt, current.receipt)) rejectAuthority("request-conflict")
        }
      }
    }
  }
  private async immutable(key: string, value: unknown, fence: () => true): Promise<void> {
    const existing = await this.get(key)
    if (existing !== undefined) { if (!same(existing, value)) rejectAuthority("request-conflict"); return }
    await this.namespace()
    assertSynchronousAuthorityGuard(fence, "policy-unqualified")
    await this.set(key, value, fence)
    if (!same(await this.get(key) ?? null, value)) rejectAuthority("storage-unavailable")
  }
  private async namespace(): Promise<void> {
    if (await this.get(`${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`) !== this.scope.namespace) rejectAuthority("namespace-mismatch")
  }
  private async get(key: string): Promise<unknown> {
    try { return await this.storage.get(key) } catch { return rejectAuthority("storage-unavailable") }
  }
  private async set(key: string, value: unknown, fence: () => true): Promise<void> {
    const bytes = canonicalAuthority(value, RECURRENCE_AUTHORITY_MAX_BYTES)
    await this.storage.set(key, JSON.parse(bytes), fence)
  }
}
