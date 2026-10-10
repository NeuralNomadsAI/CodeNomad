import { randomUUID } from "node:crypto"
import { z } from "zod"
import { runMissionExclusive } from "./exclusive"
import { stableToken, type MissionStorage } from "./journal"
import { derivedCallRecordSchema, type DerivedCallRecord } from "./derived-call-protocol"
import {
  authorityBindingSchema, authorityDigest, authorityEffectResultSchema, authorityIntentSchema, canonicalAuthority, MISSION_AUTHORITY_POLICY,
  rejectAuthority, matchesAuthorityCompletion, type AuthorityBinding, type AuthorityIntent, type AuthorityJson,
  AUTHORITY_ID_MAX_LENGTH, AUTHORITY_REQUEST_MAX_LENGTH,
} from "./authority-protocol"

export const MISSION_AUTHORITY_STORAGE_PREFIX = "codenomad-missions/authority-v2"
const PREFIX = MISSION_AUTHORITY_STORAGE_PREFIX
const NAMESPACE_KEY = `${PREFIX}/namespace`
export const authorityGrantSchema = authorityBindingSchema.extend({
  version: z.literal(1), epoch: z.number().int().positive().safe(),
  signerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["active", "revoked"]), sendsEnabled: z.boolean(),
}).strict()
export type AuthorityGrant = z.infer<typeof authorityGrantSchema>

const receiptSchema = z.object({
  requestID: z.string().min(1).max(AUTHORITY_REQUEST_MAX_LENGTH), digest: z.string().regex(/^[a-f0-9]{64}$/),
  signerDigest: z.string().regex(/^[a-f0-9]{64}$/), provisioningGeneration: z.string().min(1).max(AUTHORITY_ID_MAX_LENGTH),
  intent: authorityIntentSchema,
  // Reservation is immutable. Completion is a separate immutable receipt.
  completion: z.object({ outcome: z.enum(["applied", "rejected"]),
    result: z.union([authorityEffectResultSchema, z.object({ metadataOnly: z.literal(true) }).strict()]),
  }).strict().optional(),
}).strict().superRefine((receipt, context) => {
  if (!receipt.completion) return
  // A schema-valid result is not evidence for this intent. Reads must reject
  // damaged completion identity/kind before transactions can rewrite it.
  if (!matchesAuthorityCompletion(receipt.intent, receipt.completion)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["completion", "result"], message: "Completion does not match its intent" })
  }
})
export type AuthorityReceipt = Omit<z.infer<typeof receiptSchema>, "completion"> & {
  completion?: { outcome: "applied" | "rejected"; result: AuthorityJson }
}
const terminalSchema = z.object({ missionID: z.string().min(1).max(240), state: z.enum(["stopped", "deleted"]) }).strict()
const documentSchema = z.object({
  version: z.literal(1), policy: z.literal(MISSION_AUTHORITY_POLICY), namespace: z.string().uuid(),
  projectID: z.string().min(1).max(240), projectCanonical: z.string().min(1).max(4096),
  grants: z.array(authorityGrantSchema), receipts: z.array(receiptSchema),
  terminals: z.array(terminalSchema),
  derivedCalls: z.array(derivedCallRecordSchema).optional(),
}).strict()
export interface AuthorityDocument {
  version: 1
  policy: typeof MISSION_AUTHORITY_POLICY
  namespace: string
  projectID: string
  projectCanonical: string
  grants: AuthorityGrant[]
  receipts: AuthorityReceipt[]
  terminals: z.infer<typeof terminalSchema>[]
  /** References/claims only, never a parallel task plan or report store. */
  derivedCalls?: DerivedCallRecord[]
}
export interface AuthorityCapacity {
  grants: number
  receipts: number
  bytes: number
  /** Reserve completion space at reservation, before any external effect. */
  resultBytes: number
}
const DEFAULT_CAPACITY: AuthorityCapacity = {
  grants: 256, receipts: 1000, bytes: 2 * 1024 * 1024, resultBytes: 16 * 1024,
}

/** Single document publication avoids a torn grant/receipt pair. Native storage
 * declares get/set, not CAS: exclusion is shared with the existing project writer
 * inside one JS host. Cross-host/family exclusion remains a mandatory host gate. */
export class NativeMissionAuthorityStore {
  readonly projectToken: string
  readonly capacity: AuthorityCapacity
  private readonly key: string

  constructor(private readonly storage: MissionStorage, readonly projectID: string,
    readonly projectCanonical: string, capacity: Partial<AuthorityCapacity> = {}) {
    this.projectToken = stableToken(`${projectID}\0${projectCanonical}`, 24)
    this.key = `${PREFIX}/project/${this.projectToken}`
    this.capacity = { ...DEFAULT_CAPACITY, ...capacity }
    for (const value of Object.values(this.capacity)) {
      if (!Number.isSafeInteger(value) || value < 1) rejectAuthority("capacity")
    }
  }

  /** Explicit native plugin setup only; reads/admissions never create a namespace. */
  async initialize(): Promise<string> {
    const namespace = await runMissionExclusive(`${PREFIX}:namespace`, async () => {
      const existing = await this.get(NAMESPACE_KEY)
      if (existing !== undefined) return this.parseNamespace(existing)
      if (await this.get(this.key) !== undefined) rejectAuthority("storage-invalid")
      const created = randomUUID()
      await this.set(NAMESPACE_KEY, created)
      return this.parseNamespace(await this.get(NAMESPACE_KEY))
    })
    await runMissionExclusive(`mutation:${this.projectToken}`, async () => {
      const existing = await this.get(this.key)
      if (existing !== undefined) { this.parseDocument(existing, namespace); return }
      await this.write({ version: 1, policy: MISSION_AUTHORITY_POLICY, namespace,
        projectID: this.projectID, projectCanonical: this.projectCanonical, grants: [], receipts: [], terminals: [] })
    })
    return namespace
  }

  async read(): Promise<AuthorityDocument> {
    const namespace = this.parseNamespace(await this.get(NAMESPACE_KEY))
    const document = this.parseDocument(await this.get(this.key), namespace)
    // A namespace replaced during a read is not an authorized storage incarnation.
    if (this.parseNamespace(await this.get(NAMESPACE_KEY)) !== namespace) rejectAuthority("namespace-mismatch")
    return document
  }

  /** Callback is metadata-only; do not call a MissionControl mutator (same lock). */
  transaction<T>(operation: (document: AuthorityDocument) => Promise<T>, beforePublish?: () => void): Promise<T> {
    return runMissionExclusive(`mutation:${this.projectToken}`, async () => {
      const document = await this.read()
      const previous = JSON.parse(canonicalAuthority(document, this.capacity.bytes)) as AuthorityDocument
      const result = await operation(document)
      this.assertMonotonic(previous, document)
      if (this.parseNamespace(await this.get(NAMESPACE_KEY)) !== document.namespace) rejectAuthority("namespace-mismatch")
      beforePublish?.()
      await this.write(document)
      return result
    })
  }

  assertCapacity(document: AuthorityDocument): void {
    const active = document.grants.filter(grant => grant.state === "active")
    // An active grant reserves one immutable denial receipt and terminal marker.
    // Ordinary updates/Play cannot consume its future revoke/Stop room.
    if (document.grants.length > this.capacity.grants || document.receipts.length + (document.derivedCalls?.length ?? 0) + active.length > this.capacity.receipts
      || document.terminals.length + active.length > this.capacity.grants) rejectAuthority("capacity")
    for (const receipt of document.receipts) {
      if (receipt.completion) canonicalAuthority(receipt.completion.result, this.capacity.resultBytes)
    }
    const reservedBytes = (document.receipts.filter(receipt => !receipt.completion).length
      + (document.derivedCalls ?? []).filter(call => call.state === "reserved" || call.state === "invoking").length) * (this.capacity.resultBytes + 512)
      // Activation must retain room for immutable executor outcome evidence.
      + (document.derivedCalls ?? []).filter(call => call.state === "active").length * 32
    const denialBytes = active.reduce((bytes, grant) => bytes + this.denialReserve(grant), 0)
    const serialized = canonicalAuthority(document, this.capacity.bytes)
    if (Buffer.byteLength(serialized) + reservedBytes + denialBytes > this.capacity.bytes) rejectAuthority("capacity")
  }

  private denialReserve(grant: AuthorityGrant): number {
    // Serialize the complete largest schema-valid denial, not an estimated
    // header. JSON control characters cost six bytes EACH after escaping, so
    // string character bounds cannot serve as serialized byte bounds.
    const { version: _version, state: _state, sendsEnabled: _sends, epoch: _epoch, signerDigest: _digest, ...binding } = grant
    const requestID = "\0".repeat(AUTHORITY_REQUEST_MAX_LENGTH)
    const common = { ...binding, version: 1 as const, policy: MISSION_AUTHORITY_POLICY,
      epoch: Number.MAX_SAFE_INTEGER, expectedRevision: Number.MAX_SAFE_INTEGER, requestID } as const
    const intents: AuthorityIntent[] = [
      { ...common, method: "revoke", payload: {} },
      { ...common, method: "lifecycle", payload: { action: "stop" } },
      { ...common, method: "delete", payload: { deleteManagedSessions: false } },
    ]
    const receiptBytes = Math.max(...intents.map(intent => Buffer.byteLength(canonicalAuthority({
      requestID, digest: "f".repeat(64), signerDigest: "f".repeat(64),
      provisioningGeneration: "\0".repeat(AUTHORITY_ID_MAX_LENGTH), intent,
    }, this.capacity.bytes))))
    const terminalBytes = Buffer.byteLength(canonicalAuthority({ missionID: grant.missionID, state: "deleted" }, this.capacity.bytes))
    // Two array separators, and active->revoked / true->false each grow by one.
    // Pending completion retains the same result/header reserve as other receipts.
    return receiptBytes + terminalBytes + 4 + this.capacity.resultBytes + 512
  }

  private parseNamespace(input: unknown): string {
    const parsed = z.string().uuid().safeParse(input)
    if (!parsed.success) rejectAuthority("storage-invalid")
    return parsed.data
  }

  private parseDocument(input: unknown, namespace: string): AuthorityDocument {
    if (input === undefined) rejectAuthority("storage-invalid")
    canonicalAuthority(input, this.capacity.bytes)
    const parsed = documentSchema.safeParse(input)
    if (!parsed.success) rejectAuthority("storage-invalid")
    const doc = parsed.data as AuthorityDocument
    if (doc.namespace !== namespace) rejectAuthority("namespace-mismatch")
    if (doc.projectID !== this.projectID || doc.projectCanonical !== this.projectCanonical) rejectAuthority("binding-mismatch")
    for (const [items, key] of [[doc.grants, "missionID"], [doc.receipts, "requestID"], [doc.terminals, "missionID"]] as const) {
      if (new Set(items.map(item => (item as unknown as Record<string, string>)[key])).size !== items.length) rejectAuthority("storage-invalid")
    }
    for (const grant of doc.grants) {
      if (grant.namespace !== namespace || grant.projectID !== doc.projectID || grant.projectCanonical !== doc.projectCanonical
        || (grant.state === "revoked" && grant.sendsEnabled)
        || (grant.state === "active" && doc.terminals.some(item => item.missionID === grant.missionID))) rejectAuthority("storage-invalid")
    }
    for (const receipt of doc.receipts) {
      if (receipt.requestID !== receipt.intent.requestID || receipt.digest !== authorityDigest(receipt.intent)
        || receipt.intent.namespace !== namespace || receipt.intent.projectID !== doc.projectID
        || receipt.intent.projectCanonical !== doc.projectCanonical) rejectAuthority("storage-invalid")
    }
    const calls = doc.derivedCalls ?? []
    if (new Set(calls.map(call => call.signed.body.reservationID)).size !== calls.length) rejectAuthority("storage-invalid")
    for (const call of calls) {
      const body = call.signed.body
      if (body.namespace !== namespace || body.projectID !== doc.projectID || body.projectCanonical !== doc.projectCanonical) rejectAuthority("storage-invalid")
    }
    this.assertCapacity(doc)
    return doc
  }

  private async write(document: AuthorityDocument): Promise<void> {
    this.parseDocument(document, document.namespace)
    await this.set(this.key, JSON.parse(canonicalAuthority(document, this.capacity.bytes)))
  }
  private assertMonotonic(previous: AuthorityDocument, next: AuthorityDocument): void {
    if (previous.namespace !== next.namespace || previous.projectID !== next.projectID
      || previous.projectCanonical !== next.projectCanonical) rejectAuthority("storage-invalid")
    for (const receipt of previous.receipts) {
      const current = next.receipts.find(item => item.requestID === receipt.requestID)
      if (!current || current.digest !== receipt.digest || canonicalAuthority(current.intent) !== canonicalAuthority(receipt.intent)
        || current.signerDigest !== receipt.signerDigest || current.provisioningGeneration !== receipt.provisioningGeneration
        || (receipt.completion && (!current.completion || canonicalAuthority(current.completion) !== canonicalAuthority(receipt.completion)))) rejectAuthority("request-conflict")
    }
    for (const grant of previous.grants) {
      const current = next.grants.find(item => item.missionID === grant.missionID)
      if (!current || current.epoch < grant.epoch || current.epoch > grant.epoch + 1) rejectAuthority("epoch-conflict")
      if (current.epoch === grant.epoch) {
        const { state: _oldState, sendsEnabled: _oldSends, ...oldIdentity } = grant
        const { state: _state, sendsEnabled: _sends, ...identity } = current
        if (canonicalAuthority(identity) !== canonicalAuthority(oldIdentity)
          || grant.state === "revoked" && current.state !== "revoked") rejectAuthority("epoch-conflict")
      } else if (current.state !== "active" || current.sendsEnabled) rejectAuthority("epoch-conflict")
    }
    for (const terminal of previous.terminals) {
      const current = next.terminals.find(item => item.missionID === terminal.missionID)
      if (!current || terminal.state === "deleted" && current.state !== "deleted") rejectAuthority("authorization-blocked")
    }
    for (const call of previous.derivedCalls ?? []) {
      const current = next.derivedCalls?.find(item => item.signed.body.reservationID === call.signed.body.reservationID)
      if (!current || current.digest !== call.digest || current.publicKey !== call.publicKey
        || canonicalAuthority(current.signed) !== canonicalAuthority(call.signed)
        || call.child && canonicalAuthority(current.child ?? null) !== canonicalAuthority(call.child)
        || call.state === "reserved" && current.state !== "reserved" && current.state !== "invoking"
        || call.state === "invoking" && current.state !== "invoking" && current.state !== "active"
        || call.state === "active" && current.state !== "active" && current.state !== "ended"
        || call.state === "ended" && canonicalAuthority(current) !== canonicalAuthority(call)) rejectAuthority("request-conflict")
    }
    for (const call of next.derivedCalls ?? []) {
      if (!(previous.derivedCalls ?? []).some(item => item.signed.body.reservationID === call.signed.body.reservationID)
        && call.state !== "reserved") rejectAuthority("request-conflict")
    }
  }
  private async get(key: string): Promise<unknown> {
    try { return await this.storage.get(key) } catch { return rejectAuthority("storage-unavailable") }
  }
  private async set(key: string, value: AuthorityJson): Promise<void> {
    try { await this.storage.set(key, value) } catch { rejectAuthority("storage-unavailable") }
  }
}

export function bindingFromIntent(intent: AuthorityIntent): AuthorityBinding {
  const { authorityID, keyID, profileID, executionHost, namespace, projectID, projectCanonical,
    roots, missionID, coordinatorSessionID } = intent
  return { authorityID, keyID, profileID, executionHost, namespace, projectID, projectCanonical,
    roots, missionID, coordinatorSessionID }
}
