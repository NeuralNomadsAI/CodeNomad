import { z } from "zod"
import { authorityRootSchema, canonicalAuthority } from "./authority-protocol"
import { stableToken } from "./journal"
import { dailyClockSchema, dailyOccurrence } from "./recurrence-clock"
import { missionProfilesInputSchema, validateMissionProfiles } from "./playbook-profiles"
import { missionTaskModeInputSchema } from "./task-execution-mode"

export const RECURRENCE_STORAGE_PREFIX = "codenomad-missions/recurrence-v1"
export const RECURRENCE_HISTORY_LIMIT = 30
export const RECURRENCE_SCHEDULE_LIMIT = 64
export const RECURRENCE_CURSOR_LIMIT = 64
export const RECURRENCE_MAX_BYTES = 256 * 1024
export const recurrenceIDSchema = z.string().regex(/^[A-Za-z0-9_-]{3,100}$/)
const id = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/)
const counter = z.number().int().nonnegative().safe()
const timestamp = counter.max(Date.parse("9999-12-28T00:00:00Z"))
const ids = z.array(id).max(32).refine(items => new Set(items).size === items.length)

/** Explicit persisted selections, never a dynamic default or native tool-rights
 * sandbox. Ownership, permissions and publication enforcement belong to the
 * authorized admission composition, not standing-consigne text. */
export const recurrenceConfigSchema = z.object({
  consigne: z.string().min(1).max(20_000), clock: dailyClockSchema,
  profileID: id, executionHost: id,
  profiles: missionProfilesInputSchema.refine(profiles => {
    if (!profiles?.coordinator || !profiles.roles?.specialist) return false
    try { validateMissionProfiles("custom", profiles) } catch { return false }
    return [profiles.coordinator, ...Object.values(profiles.roles)].every(selection =>
      !!selection.agent && !!selection.model?.providerID && !!selection.model.id)
  }, "Recurrence requires exact coordinator/specialist agent and model selections"),
  taskMode: missionTaskModeInputSchema,
  roots: z.array(authorityRootSchema).min(1).max(32).refine(roots =>
    new Set(roots.map(root => root.directory)).size === roots.length),
  watchedConversationIDs: ids,
  publication: z.object({ policy: z.enum(["disabled", "draft-only", "authorized-targets"]), conversationIDs: ids }).strict()
    .refine(value => value.policy === "authorized-targets" ? value.conversationIDs.length > 0 : value.conversationIDs.length === 0),
}).strict().refine(config => {
  // Leave fixed worst-case room for 30 reference receipts, cursors and an
  // unfinished passage BEFORE dispatch. Settling cannot exhaust the ledger.
  try { canonicalAuthority(config, 64 * 1024); return true } catch { return false }
}, "Recurrence configuration capacity")
export type RecurrenceConfig = z.infer<typeof recurrenceConfigSchema>

const dailyDueSchema = z.object({ kind: z.literal("daily"), clock: dailyClockSchema,
  civilDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), at: timestamp }).strict()
const dueSchema = z.union([dailyDueSchema, z.object({ kind: z.literal("manual"), requestID: recurrenceIDSchema,
  expectedRevision: counter, at: timestamp }).strict()])
export type RecurrenceDue = z.infer<typeof dueSchema>
const passageSchema = z.object({ id: recurrenceIDSchema, messageID: recurrenceIDSchema,
  scheduleRevision: counter, due: dueSchema, createdAt: timestamp }).strict()
export type RecurrencePassage = z.infer<typeof passageSchema>

export const recurrenceAdmissionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), passageID: recurrenceIDSchema, messageID: recurrenceIDSchema,
    missionID: id, conversationID: id }).strict(),
  // The authorized adapter may return this ONLY with exact positive evidence
  // that no external effect occurred. Errors, partial writes and lost ACKs do
  // not satisfy this contract and must remain uncertain.
  z.object({ kind: z.literal("rejected-before-effect"), passageID: recurrenceIDSchema, messageID: recurrenceIDSchema,
    effect: z.literal("none"), proofID: id }).strict(),
])
export type RecurrenceAdmission = z.infer<typeof recurrenceAdmissionSchema>
const cursorListSchema = z.array(z.object({ conversationID: id, messageID: id }).strict())
  .refine(items => new Set(items.map(item => item.conversationID)).size === items.length)
export const recurrenceResultSchema = z.object({ passageID: recurrenceIDSchema, messageID: recurrenceIDSchema,
  missionID: id, conversationID: id, outcome: z.enum(["completed", "failed", "stopped"]),
  // References only: artifacts/transcripts stay in native conversations.
  artifactMessageIDs: z.array(id).max(8).refine(items => new Set(items).size === items.length),
  cursors: cursorListSchema.refine(items => items.length <= 32),
}).strict()
export type RecurrenceResult = z.infer<typeof recurrenceResultSchema>
const receiptSchema = z.object({ passage: passageSchema, settledAt: timestamp,
  result: z.union([recurrenceResultSchema.omit({ cursors: true }), recurrenceAdmissionSchema.options[1]]) }).strict()
const documentSchema = z.object({ version: z.literal(1), projectID: id, projectCanonical: z.string().min(1).max(4096),
  id: recurrenceIDSchema, revision: counter, scheduleRevision: counter, createdAt: timestamp,
  state: z.enum(["paused", "running", "stopped"]), config: recurrenceConfigSchema,
  lastDaily: dailyDueSchema.nullable(), settledCount: counter,
   cursors: cursorListSchema.refine(items => items.length <= RECURRENCE_CURSOR_LIMIT),
  pending: z.object({ passage: passageSchema, admission: recurrenceAdmissionSchema.options[0].nullable() }).strict().nullable(),
  history: z.array(receiptSchema).max(RECURRENCE_HISTORY_LIMIT),
}).strict()
export type RecurrenceDocument = z.infer<typeof documentSchema>

export function recurrencePassageID(projectToken: string, scheduleID: string, scheduleRevision: number, due: RecurrenceDue): string {
  const dueIdentity = due.kind === "daily" ? `daily:${due.civilDay}` : `manual:${due.expectedRevision}:${due.requestID}`
  return `rcp_${stableToken(`${projectToken}\0${scheduleID}\0${scheduleRevision}\0${dueIdentity}`, 40)}`
}
export function recurrenceMessageID(passageID: string): string { return `msg_${stableToken(passageID, 28)}` }

/** Strict bounded codec, including stored identity/placement relationships. No
 * repair, schema stripping, legacy reads, transcript retention or defaulting. */
export function parseRecurrenceDocument(input: unknown, projectID: string, projectCanonical: string, scheduleID: string): RecurrenceDocument {
  const json = canonicalAuthority(input, RECURRENCE_MAX_BYTES)
  const doc = documentSchema.parse(JSON.parse(json))
  const fail = () => { throw new Error("Invalid recurrence storage identity") }
  if (doc.projectID !== projectID || doc.projectCanonical !== projectCanonical || doc.id !== scheduleID
    || doc.scheduleRevision > doc.revision || doc.history.length !== Math.min(doc.settledCount, RECURRENCE_HISTORY_LIMIT)
    || doc.revision < 2 * doc.settledCount + (doc.pending ? 1 : 0)
    || doc.settledCount === 0 && doc.cursors.length !== 0) fail()
  const projectToken = stableToken(`${projectID}\0${projectCanonical}`, 24)
  const passages = [...doc.history.map(receipt => receipt.passage), ...(doc.pending ? [doc.pending.passage] : [])]
  if (new Set(passages.map(passage => passage.id)).size !== passages.length) fail()
  if (doc.lastDaily && (!/^\d{4}-\d{2}-\d{2}$/.test(doc.lastDaily.civilDay)
    || !Number.isFinite(Date.parse(`${doc.lastDaily.civilDay}T00:00:00Z`))
    || new Date(`${doc.lastDaily.civilDay}T00:00:00Z`).toISOString().slice(0, 10) !== doc.lastDaily.civilDay
    || doc.lastDaily.at < doc.createdAt || !passages.length
    || doc.lastDaily.at > Math.max(...passages.map(passage => passage.createdAt)))) fail()
  const validateDaily = (due: Extract<RecurrenceDue, { kind: "daily" }>) => {
    const occurrence = dailyOccurrence(due.clock, due.civilDay)
    if (!occurrence || occurrence.at !== due.at) fail()
  }
  if (doc.lastDaily) validateDaily(doc.lastDaily)
  let previousDaily: Extract<RecurrenceDue, { kind: "daily" }> | undefined
  let previousScheduleRevision = 0
  for (const passage of passages) {
    if (passage.scheduleRevision > doc.scheduleRevision || passage.createdAt < doc.createdAt || passage.createdAt < passage.due.at
      || passage.id !== recurrencePassageID(projectToken, doc.id, passage.scheduleRevision, passage.due)
      || passage.messageID !== recurrenceMessageID(passage.id)) fail()
    if (passage.scheduleRevision < previousScheduleRevision) fail()
    previousScheduleRevision = passage.scheduleRevision
    if (passage.due.kind === "manual" && (passage.due.expectedRevision >= doc.revision || passage.due.at !== passage.createdAt)) fail()
    if (passage.due.kind === "daily") {
      validateDaily(passage.due)
      if (!doc.lastDaily || passage.due.civilDay > doc.lastDaily.civilDay || passage.due.at > doc.lastDaily.at
        || previousDaily && (passage.due.civilDay <= previousDaily.civilDay || passage.due.at <= previousDaily.at)) fail()
      previousDaily = passage.due
    }
  }
  const matches = (passage: RecurrencePassage, result: { passageID: string; messageID: string }) =>
    passage.id === result.passageID && passage.messageID === result.messageID
  if (doc.pending) {
    const { passage, admission } = doc.pending
    if (passage.scheduleRevision !== doc.scheduleRevision || admission && !matches(passage, admission)) fail()
    if (passage.due.kind === "daily") {
      if (canonicalAuthority(passage.due.clock) !== canonicalAuthority(doc.config.clock)
        || canonicalAuthority(passage.due) !== canonicalAuthority(doc.lastDaily)) fail()
    }
  }
  let previousSettlement = doc.createdAt
  for (const receipt of doc.history) {
    if (!matches(receipt.passage, receipt.result) || receipt.passage.createdAt < previousSettlement || receipt.settledAt < receipt.passage.createdAt) fail()
    previousSettlement = receipt.settledAt
  }
  if (doc.pending && doc.pending.passage.createdAt < previousSettlement) fail()
  // Removing a watch revokes future reads, not its processed-message high-water.
  // ponytail: 64 remembered conversations; archive/reconcile explicitly beyond this ceiling, never reset dedup silently.
  if (new Set([...doc.cursors.map(cursor => cursor.conversationID), ...doc.config.watchedConversationIDs]).size > RECURRENCE_CURSOR_LIMIT) fail()
  return doc
}
