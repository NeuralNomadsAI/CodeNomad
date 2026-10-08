import { createHash, verify } from "node:crypto"
import { z } from "zod"
import { authorityBindingSchema, authorityDigest, authoritySignerDigest, canonicalAuthority, MISSION_AUTHORITY_POLICY,
  rejectAuthority, snapshotAuthoritySigner, type AuthoritySignerSnapshot, type ProvisionedAuthoritySigner } from "./authority-protocol"
import { recurrenceConfigSchema, recurrenceIDSchema, recurrenceMessageID, recurrencePassageID,
  parseRecurrenceDocument, type RecurrenceDocument } from "./recurrence-contract"
import { dailyClockSchema, dailyOccurrence } from "./recurrence-clock"
import { derivedExecutionSchema } from "./derived-call-protocol"
import { stableToken } from "./journal"
import { recurrenceSourceContextLimit, RECURRENCE_SOURCE_REFERENCE_RESERVE } from "./recurrence-read-budget"

export const RECURRENCE_AUTHORITY_POLICY = "codenomad.missions.recurrence-standing/human-signed-v1" as const
/** Exact schedule-local human identity. Native epoch CAS makes historical IDs
 * unreplayable without an unbounded host-side request history. */
export function recurrenceHumanRequestID(scheduleID: string, epoch: number, action: "authorize" | "pause" | "revoke"): string {
  return `rhuman_${recurrenceAuthorityDigest({ scheduleID, epoch, action })}`
}
export const RECURRENCE_AUTHORITY_MAX_BYTES = 256 * 1024
/** Qualification includes a ledger plus exact source/receipt evidence. */
export const RECURRENCE_QUALIFICATION_MAX_BYTES = 768 * 1024
export function recurrenceAuthorityDigest(value: unknown, maxBytes = RECURRENCE_AUTHORITY_MAX_BYTES): string {
  return createHash("sha256").update(canonicalAuthority(value, maxBytes)).digest("hex")
}
const id = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/)
const counter = z.number().int().nonnegative().safe()
const positive = counter.min(1)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const uniqueIDs = (max: number) => z.array(id).max(max).refine(items => new Set(items).size === items.length)
const binding = authorityBindingSchema.omit({ missionID: true, coordinatorSessionID: true })
export const recurrenceProfileSourceSchema = z.object({ profileID: id, executionHost: id,
  configYamlPath: z.string().min(1).max(4096).refine(value => !value.includes("\0")) }).strict()
export type RecurrenceProfileSource = z.infer<typeof recurrenceProfileSourceSchema>
export const recurrenceAuthorityScopeSchema = binding.omit({ authorityID: true, keyID: true, roots: true }).extend({
  scheduleID: recurrenceIDSchema, daemonStorageID: id,
}).strict()
export type RecurrenceAuthorityScope = z.infer<typeof recurrenceAuthorityScopeSchema>
/** Per-passage ceilings; unknown invocations remain charged. No TTL or renewal. */
export const recurrenceAuthorityBudgetsSchema = z.object({ effects: positive.max(64), nativeCalls: counter.max(32),
  inboxMessages: counter.max(256), publications: counter.max(32) }).strict()
export const recurrenceStandingIntentSchema = binding.extend({
  version: z.literal(1), policy: z.literal(RECURRENCE_AUTHORITY_POLICY), scheduleID: recurrenceIDSchema,
  daemonStorageID: id, scheduleRevision: counter, epoch: positive, expectedRevision: counter.nullable(), requestID: recurrenceIDSchema,
  provisioningGeneration: id, signerDigest: digest, action: z.enum(["authorize", "pause", "revoke"]),
  configDigest: digest, config: recurrenceConfigSchema, profileSource: recurrenceProfileSourceSchema, budgets: recurrenceAuthorityBudgetsSchema,
}).strict().superRefine((body, context) => {
  if (body.requestID !== recurrenceHumanRequestID(body.scheduleID, body.epoch, body.action)
    || body.configDigest !== authorityDigest(body.config) || body.profileID !== body.config.profileID
    || body.profileSource.profileID !== body.profileID || body.profileSource.executionHost !== body.executionHost
    || body.executionHost !== body.config.executionHost || canonicalAuthority(body.roots) !== canonicalAuthority(body.config.roots)) {
    context.addIssue({ code: "custom", message: "Standing configuration binding differs" })
  }
})
export const signedRecurrenceStandingIntentSchema = z.object({ body: recurrenceStandingIntentSchema,
  signature: z.string().length(88).regex(/^[A-Za-z0-9+/]{86}==$/) }).strict()
export type RecurrenceStandingIntent = z.infer<typeof recurrenceStandingIntentSchema>
export type SignedRecurrenceStandingIntent = z.infer<typeof signedRecurrenceStandingIntentSchema>

export function recurrenceStandingSigningBytes(body: RecurrenceStandingIntent): Buffer {
  return Buffer.from(`${RECURRENCE_AUTHORITY_POLICY}\n${canonicalAuthority(body)}`)
}
/** Only a trusted construction-time provisioning map supplies keys. Signed JSON
 * is not human admission: the core additionally requires the protected human gate. */
export function authenticateRecurrenceStanding(input: unknown, signers: readonly ProvisionedAuthoritySigner[]): {
  signed: SignedRecurrenceStandingIntent; signer: AuthoritySignerSnapshot
} {
  canonicalAuthority(input)
  const parsed = signedRecurrenceStandingIntentSchema.safeParse(input)
  if (!parsed.success) rejectAuthority("invalid-intent")
  const { body, signature } = parsed.data
  const matches = signers.filter(signer => ["authorityID", "keyID", "profileID", "executionHost", "namespace",
    "projectID", "projectCanonical", "provisioningGeneration"].every(key =>
    signer[key as keyof ProvisionedAuthoritySigner] === body[key as keyof RecurrenceStandingIntent])
    && canonicalAuthority(signer.roots) === canonicalAuthority(body.roots))
  if (matches.length !== 1) rejectAuthority("untrusted-signer")
  const selected = matches[0]
  if (selected.policy !== MISSION_AUTHORITY_POLICY || selected.qualification !== "qualified") rejectAuthority("policy-unqualified")
  if (selected.publicKey.type !== "public" || selected.publicKey.asymmetricKeyType !== "ed25519") rejectAuthority("untrusted-signer")
  const signer = snapshotAuthoritySigner(selected), bytes = Buffer.from(signature, "base64")
  if (body.signerDigest !== authoritySignerDigest(signer.publicKey) || bytes.toString("base64") !== signature
    || !verify(null, recurrenceStandingSigningBytes(body), signer.publicKey, bytes)) rejectAuthority("untrusted-signer")
  return { signed: parsed.data, signer }
}

const passage = z.object({ id: recurrenceIDSchema, messageID: recurrenceIDSchema, scheduleRevision: counter,
  createdAt: counter, due: z.union([
    z.object({ kind: z.literal("daily"), clock: dailyClockSchema, civilDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), at: counter }).strict(),
    z.object({ kind: z.literal("manual"), requestID: recurrenceIDSchema, expectedRevision: counter, at: counter }).strict(),
  ]) }).strict()
export const recurrenceChildGrantSchema = z.object({ version: z.literal(1), grantID: id, parentDigest: digest,
  parentEpoch: positive, sequence: positive, configDigest: digest, documentDigest: digest, passage,
  missionID: id, coordinatorSessionID: id, messageID: id }).strict()
export type RecurrenceChildGrant = z.infer<typeof recurrenceChildGrantSchema>
export function deriveRecurrenceChild(parent: SignedRecurrenceStandingIntent, raw: Readonly<RecurrenceDocument>, sequence: number): RecurrenceChildGrant {
  const body = parent.body, doc = parseRecurrenceDocument(raw, body.projectID, body.projectCanonical, body.scheduleID)
  if (!doc.pending || doc.pending.admission || doc.state === "stopped" || doc.pending.passage.due.kind === "daily" && doc.state !== "running"
    || doc.scheduleRevision !== body.scheduleRevision || canonicalAuthority(doc.config) !== canonicalAuthority(body.config)
    || doc.settledCount !== sequence - 1) rejectAuthority("binding-mismatch")
  const missionID = `msn_${stableToken(`${body.projectID}\0${doc.pending.passage.id}`, 24)}`
  const identity = { version: 1 as const, parentDigest: authorityDigest(parent), parentEpoch: body.epoch, sequence,
    configDigest: body.configDigest, documentDigest: recurrenceAuthorityDigest(doc), passage: doc.pending.passage, missionID,
    coordinatorSessionID: `ses_${stableToken(`${missionID}\0coordinator`, 26)}`, messageID: doc.pending.passage.messageID }
  return recurrenceChildGrantSchema.parse({ ...identity, grantID: `rgrant_${authorityDigest(identity).slice(0, 48)}` })
}
export function assertRecurrenceChild(parent: SignedRecurrenceStandingIntent, grant: RecurrenceChildGrant): void {
  const body = parent.body, project = stableToken(`${body.projectID}\0${body.projectCanonical}`, 24)
  const { grantID, ...identity } = grant, due = grant.passage.due
  const missionID = `msn_${stableToken(`${body.projectID}\0${grant.passage.id}`, 24)}`
  if (grantID !== `rgrant_${authorityDigest(identity).slice(0, 48)}` || grant.parentDigest !== authorityDigest(parent)
    || grant.parentEpoch !== body.epoch || grant.configDigest !== body.configDigest || grant.passage.scheduleRevision !== body.scheduleRevision
    || grant.passage.id !== recurrencePassageID(project, body.scheduleID, body.scheduleRevision, due)
    || grant.messageID !== recurrenceMessageID(grant.passage.id) || grant.passage.messageID !== grant.messageID
    || grant.missionID !== missionID || grant.coordinatorSessionID !== `ses_${stableToken(`${missionID}\0coordinator`, 26)}`
    || grant.passage.createdAt < due.at || due.kind === "manual" && grant.passage.createdAt !== due.at
    || due.kind === "daily" && (canonicalAuthority(due.clock) !== canonicalAuthority(body.config.clock)
      || dailyOccurrence(due.clock, due.civilDay)?.at !== due.at)) rejectAuthority("storage-invalid")
}

export const recurrenceEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create") }).strict(), z.object({ kind: z.literal("start") }).strict(),
  z.object({ kind: z.literal("coordinator-message"), messageID: id, contentDigest: digest }).strict(),
  z.object({ kind: z.literal("native-call"), taskKey: id, generation: positive, parentSessionID: id,
    parentMessageID: id, toolCallID: id, directory: z.string().min(1).max(4096), execution: derivedExecutionSchema,
    mode: z.enum(["native", "independent"]), targetSessionID: id.optional() }).strict(),
  z.object({ kind: z.literal("inbox-read"), conversationID: id, messageIDs: uniqueIDs(32),
    read: z.object({ directory: z.string().min(1).max(4096), workspaceID: id.optional(),
      afterMessageID: id.nullable(), limit: positive.max(32),
      contextLimit: positive.min(RECURRENCE_SOURCE_REFERENCE_RESERVE).max(16_384) }).strict().optional() }).strict(),
  z.object({ kind: z.literal("publish"), conversationID: id, messageID: id, contentDigest: digest }).strict(),
])
export type RecurrenceEffect = z.infer<typeof recurrenceEffectSchema>
export const recurrenceSourceMessageSchema = z.object({ id, type: id, text: z.string().max(16_384),
  nativeDigest: digest, completedAt: counter.optional(), needsDecision: z.literal("source-input-capacity").optional() }).strict()
  .refine(message => message.type !== "assistant" || message.completedAt !== undefined)
  .refine(message => !message.needsDecision || message.text === "")
export const recurrenceEffectReceiptSchema = z.object({ operationID: id, outcome: z.enum(["applied", "rejected-before-effect"]), evidenceID: id,
  sourceMessages: z.array(recurrenceSourceMessageSchema).max(32).refine(messages => {
    try { canonicalAuthority(messages, 64 * 1024); return true } catch { return false }
  }).optional() }).strict()
export type RecurrenceEffectReceipt = z.infer<typeof recurrenceEffectReceiptSchema>
export const recurrenceEffectRecordSchema = z.object({ operationID: id, effect: recurrenceEffectSchema,
  receipt: recurrenceEffectReceiptSchema.nullable() }).strict()
export type RecurrenceEffectRecord = z.infer<typeof recurrenceEffectRecordSchema>
export function recurrenceEffectID(grant: RecurrenceChildGrant, effect: RecurrenceEffect): string {
  return `rce_${authorityDigest({ grantID: grant.grantID, effect }).slice(0, 48)}`
}
export const recurrenceChildRecordSchema = z.object({ parent: signedRecurrenceStandingIntentSchema,
  grant: recurrenceChildGrantSchema, effects: z.array(recurrenceEffectRecordSchema).max(64) }).strict()
export type RecurrenceChildRecord = z.infer<typeof recurrenceChildRecordSchema>
/** Validate every stored claim as well as a proposed one. Descriptor hashes alone
 * cannot deduplicate a logical native invocation or a message with changed text. */
export function assertRecurrenceEffectScope(child: RecurrenceChildRecord, effect: RecurrenceEffect): void {
  const config = child.parent.body.config, budgets = child.parent.body.budgets, effects = child.effects
  if (effects.length >= budgets.effects) rejectAuthority("capacity")
  const applied = (kind: RecurrenceEffect["kind"]) => effects.some(item => item.effect.kind === kind && item.receipt?.outcome === "applied")
  if (effect.kind === "create" && effects.some(item => item.effect.kind === "create")
    || effect.kind === "start" && (!applied("create") || effects.some(item => item.effect.kind === "start"))
    || !["create", "start", "inbox-read"].includes(effect.kind) && !applied("start")) rejectAuthority("authorization-blocked")
  if (effect.kind === "coordinator-message" && effects.some(item => item.effect.kind === "coordinator-message"
    && item.effect.messageID === effect.messageID)) rejectAuthority("request-conflict")
  if (effect.kind === "native-call") {
    if (effects.some(item => item.effect.kind === "native-call" && item.effect.parentSessionID === effect.parentSessionID
      && (item.effect.toolCallID === effect.toolCallID || item.effect.taskKey === effect.taskKey
        && item.effect.generation === effect.generation && item.effect.parentMessageID === effect.parentMessageID))) rejectAuthority("request-conflict")
    if (effects.filter(item => item.effect.kind === "native-call").length >= budgets.nativeCalls) rejectAuthority("capacity")
    if (effect.mode !== config.taskMode || !config.roots.some(root => root.directory === effect.directory)
      || canonicalAuthority(effect.execution) !== canonicalAuthority(config.profiles!.roles!.specialist)) rejectAuthority("binding-mismatch")
  }
  if (effect.kind === "inbox-read") {
    if (!config.watchedConversationIDs.includes(effect.conversationID)) rejectAuthority("authorization-blocked")
    const previous = effects.filter(item => item.effect.kind === "inbox-read" && item.effect.read)
    if (effect.read && previous.some(item => item.receipt?.outcome !== "applied" || !item.receipt.sourceMessages)) rejectAuthority("authorization-blocked")
    if (effect.read && (effect.messageIDs.length || !config.roots.some(root => root.directory === effect.read!.directory)
      || effect.conversationID !== config.watchedConversationIDs[previous.length]
      || effect.read.contextLimit !== recurrenceSourceContextLimit(config, previous.map(item => item.receipt!.sourceMessages!))
      || effects.some(item => item.effect.kind === "inbox-read" && item.effect.conversationID === effect.conversationID))) rejectAuthority("binding-mismatch")
    const count = effects.reduce((sum, item) => sum + (item.effect.kind === "inbox-read" ? item.effect.read?.limit ?? item.effect.messageIDs.length : 0), 0)
    if (count + (effect.read?.limit ?? effect.messageIDs.length) > budgets.inboxMessages) rejectAuthority("capacity")
  }
  if (effect.kind === "publish") {
    if (config.publication.policy !== "authorized-targets" || !config.publication.conversationIDs.includes(effect.conversationID)) rejectAuthority("authorization-blocked")
    if (effects.some(item => item.effect.kind === "publish" && item.effect.conversationID === effect.conversationID
      && item.effect.messageID === effect.messageID)) rejectAuthority("request-conflict")
    if (effects.filter(item => item.effect.kind === "publish").length >= budgets.publications) rejectAuthority("capacity")
  }
}
export const recurrenceSettlementSchema = z.object({ grantID: id, evidenceID: id,
  outcome: z.enum(["completed", "failed", "stopped", "rejected-before-effect"]),
  effects: z.array(recurrenceEffectReceiptSchema).max(64), nativeIdle: z.literal(true),
  controlsSettled: z.literal(true), notificationsSettled: z.literal(true), derivedCallsEnded: z.literal(true) }).strict()
export type RecurrenceSettlement = z.infer<typeof recurrenceSettlementSchema>
export const recurrenceAuthorityArchiveSchema = z.object({ version: z.literal(1), child: recurrenceChildRecordSchema,
  settlement: recurrenceSettlementSchema, previousArchiveDigest: digest.nullable() }).strict()
export type RecurrenceAuthorityArchive = z.infer<typeof recurrenceAuthorityArchiveSchema>
