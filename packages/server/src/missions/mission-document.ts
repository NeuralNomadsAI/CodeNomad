import { z } from "zod"
import { canonicalAuthority } from "./authority-protocol"
import { stableToken, controlOperationID, controlResumeAdmissionID } from "./receipt-identity"
import { missionCoordinatorSessionID } from "./session-identity"
import { parseMissionNativeAcknowledgement } from "./lifecycle-schema"
import { missionCalendarOwnerSchema } from "./mission-calendar-owner-state"
import {
  documentCounter, documentID, documentTimestamp, nativeDocumentID, missionConfigurationSchema,
  missionLaunchLimit, missionSlotEndsAt, MISSION_DOCUMENT_MAX_BYTES, type MissionConfiguration,
} from "./launch-policy"

export const MISSION_DOCUMENT_PREFIX = "codenomad-missions/documents-v1"
export const MISSION_DOCUMENT_HISTORY_LIMIT = 30
export const MISSION_TOMBSTONE_LIMIT = 4096
export const MISSION_TOMBSTONE_MAX_BYTES = 1024 * 1024
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const requestID = z.string().min(1).max(128)
export const missionDocumentDeletionIdentitySchema = z.object({ requestID, expectedRevision: documentCounter,
  deleteManagedSessions: z.boolean() }).strict()
const generation = documentCounter.positive()
const firstPlayAcknowledgement = z.unknown().transform((input, context) => {
  const acknowledgement = parseMissionNativeAcknowledgement(input)
  if (acknowledgement?.disposition === "start-admitted") return acknowledgement
  context.addIssue({ code: "custom", message: "Invalid original first-Play acknowledgement" })
  return z.NEVER
})
export const missionScheduleActivationSchema = z.object({ requestID, expectedRevision: documentCounter, authority: digest,
  state: z.enum(["prepared", "partial", "ready", "failed"]),
  targets: z.array(z.object({ scope: z.enum(["global", "project"]), path: z.string().min(1).max(4096),
    expectation: digest,
    resultDigest: digest, attempted: z.boolean(), acknowledged: z.boolean() }).strict()
      .refine(value => !value.acknowledged || value.attempted)).max(2)
    .refine(targets => new Set(targets.map(item => item.path)).size === targets.length && new Set(targets.map(item => item.scope)).size === targets.length),
  effectiveOrigin: z.string().min(1).max(4096).nullable().optional(), errorCode: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
}).strict().refine(value => value.state !== "ready" || value.targets.every(target => target.acknowledged) && value.effectiveOrigin !== undefined)
export type MissionScheduleActivation = z.infer<typeof missionScheduleActivationSchema>
const oneTime = z.object({ creationRequestID: requestID, creationDigest: digest, coordinatorSessionID: nativeDocumentID,
  location: z.object({ directory: z.string().min(1).max(4096), workspaceID: nativeDocumentID.optional() }).strict(),
  firstPlay: z.object({ requestID, expectedRevision: documentCounter.positive(), operationID: nativeDocumentID,
    messageID: nativeDocumentID, requestedAt: documentTimestamp, admittedAt: documentTimestamp.nullable(),
    acknowledgement: firstPlayAcknowledgement.nullable() }).strict().nullable(),
}).strict()
const checkpoint = z.object({ key: digest, kind: z.enum(["schedule-success", "mission-completed", "branch-commits", "conversation-message", "files-changed"]),
  placementDigest: digest, value: z.unknown().transform((value, context) => {
    try { return JSON.parse(canonicalAuthority(value, 32 * 1024)) as import("./model").MissionJsonValue }
    catch { context.addIssue({ code: "custom", message: "Invalid source checkpoint" }); return z.NEVER }
  }),
}).strict()
export const missionCheckpointsSchema = z.array(checkpoint).max(64).refine(items => new Set(items.map(item => item.key)).size === items.length)
const checkpoints = missionCheckpointsSchema
export const missionWakeSchema = z.object({ scheduleID: nativeDocumentID, run: documentCounter.positive(),
  messageID: nativeDocumentID, dueAt: documentTimestamp }).strict().refine(wake => wake.messageID === `msg_${wake.scheduleID}_${wake.run}`)
export type MissionWake = z.infer<typeof missionWakeSchema>
const calendar = z.object({ role: z.enum(["principal", "reconciliation"]), slot: documentCounter.max(7),
  timeGeneration: generation, scheduleID: nativeDocumentID, sessionID: nativeDocumentID, highWater: documentCounter,
  pendingWake: missionWakeSchema.nullable(), wakePreparing: missionWakeSchema.nullable(),
}).strict()
export type MissionCalendar = z.infer<typeof calendar>
const origin = z.union([
  z.object({ kind: z.literal("immediate"), requestID: documentID }).strict(),
  z.object({ kind: z.literal("manual"), requestID: documentID }).strict(),
  z.object({ kind: z.literal("wake"), wakes: z.array(missionWakeSchema).min(1).max(8)
    .refine(wakes => new Set(wakes.map(wake => wake.scheduleID)).size === wakes.length) }).strict(),
])
const pending = z.object({ id: documentID, missionID: documentID, coordinatorSessionID: nativeDocumentID, messageID: nativeDocumentID,
  configurationGeneration: generation, timeGeneration: generation, createdAt: documentTimestamp, dueAt: documentTimestamp,
  origin, configuration: missionConfigurationSchema, checkpoints, admittedAt: documentTimestamp.nullable(),
  manualAllowed: z.boolean().optional().default(false),
  admissionAttempted: z.boolean().optional().default(false),
  manualExpectedRevision: documentCounter.optional(),
}).strict()
export type MissionDocumentPending = z.infer<typeof pending>
const receipt = pending.omit({ configuration: true, checkpoints: true }).extend({ configurationDigest: digest,
  settledAt: documentTimestamp, outcome: z.enum(["completed", "failed", "ended-without-report"]), reason: z.literal("not-started").optional(),
}).strict()
const document = z.object({ version: z.literal(1), id: documentID, projectID: nativeDocumentID,
  projectCanonical: z.string().min(1).max(4096), revision: documentCounter,
  configurationGeneration: generation, timeGeneration: generation,
  createdAt: documentTimestamp, configuration: missionConfigurationSchema,
  state: z.enum(["paused", "running", "stopped", "finished"]),
  firstPlayedAt: documentTimestamp.nullable(), oneShotAt: documentTimestamp.nullable(), slotEndsAt: documentTimestamp.nullable(),
  launchedCount: documentCounter, settledCount: documentCounter, successfulCount: documentCounter.default(0),
  lastSuccessfulPassageID: documentID.nullable().default(null), everCreatedTask: z.boolean(),
  blocked: z.enum(["failed", "ended-without-report", "unknown"]).nullable(),
  creation: z.object({ requestID, digest }).strict().optional(),
  oneTime: oneTime.nullable(), scheduleActivation: missionScheduleActivationSchema.nullable(),
  calendarOwner: missionCalendarOwnerSchema.nullable().default(null),
  fanIn: z.object({ incarnation: z.string().min(1).max(240), cutoff: documentTimestamp, timeGeneration: generation,
    principalIDs: z.array(nativeDocumentID).max(8).refine(ids => new Set(ids).size === ids.length), completed: z.boolean(), suppress: z.boolean() }).strict().nullable().default(null),
  calendars: z.array(calendar).max(9),
  synchronization: z.object({ requestID: documentID, kind: z.enum(["arm", "replace", "disarm", "delete"]),
    retiredCalendars: z.array(calendar).max(9) }).strict().nullable(),
  deletion: missionDocumentDeletionIdentitySchema.extend({ requestedAt: documentTimestamp }).strict().nullable(),
  checkpoints, pending: pending.nullable(), history: z.array(receipt).max(MISSION_DOCUMENT_HISTORY_LIMIT),
}).strict()
export type MissionDocument = z.infer<typeof document>
export type MissionSourceCheckpoint = z.infer<typeof checkpoint>

/** Bounded metadata only. Execution profiles/results remain in each passage's
 * existing journal range, addressed by the immutable missionID in the receipt. */
export function parseMissionDocument(input: unknown, identity: Pick<MissionDocument, "id" | "projectID" | "projectCanonical">): MissionDocument {
  const doc = document.parse(JSON.parse(canonicalAuthority(input, MISSION_DOCUMENT_MAX_BYTES)))
  const fail = () => { throw new Error("Invalid Mission document identity or progress") }
  if (doc.id !== identity.id || doc.projectID !== identity.projectID || doc.projectCanonical !== identity.projectCanonical
    || doc.configurationGeneration > doc.revision + 1 || doc.timeGeneration > doc.configurationGeneration
    || doc.history.length !== Math.min(doc.settledCount, MISSION_DOCUMENT_HISTORY_LIMIT)
    || doc.successfulCount > doc.settledCount || doc.successfulCount < doc.history.filter(item => item.outcome === "completed").length
    || (doc.successfulCount === 0) !== (doc.lastSuccessfulPassageID === null)
    || doc.history.some(item => item.id === doc.lastSuccessfulPassageID && item.outcome !== "completed")
    || doc.history.some(item => item.outcome === "completed") && doc.history.filter(item => item.outcome === "completed").at(-1)!.id !== doc.lastSuccessfulPassageID
    || doc.firstPlayedAt !== null && doc.firstPlayedAt < doc.createdAt
    || doc.firstPlayedAt === null && (doc.launchedCount || doc.pending || doc.settledCount || doc.calendars.length || doc.state === "running"
      || doc.oneShotAt !== null || doc.slotEndsAt !== null)
    || doc.firstPlayedAt !== null && doc.slotEndsAt !== missionSlotEndsAt(doc.configuration.launch, doc.firstPlayedAt)
    || doc.deletion && doc.state !== "stopped"
    || doc.firstPlayedAt !== null && (doc.configuration.launch.timing.kind === "at" && doc.oneShotAt !== doc.configuration.launch.timing.at
      || !["at", "in"].includes(doc.configuration.launch.timing.kind) && doc.oneShotAt !== null
      || doc.configuration.launch.timing.kind === "in" && (doc.oneShotAt === null || doc.oneShotAt <= doc.firstPlayedAt))) fail()
  const principals = doc.calendars.filter(item => item.role === "principal")
  if (principals.length > 8 || doc.calendars.filter(item => item.role === "reconciliation").length > 1
    || new Set(doc.calendars.map(item => `${item.role}:${item.slot}`)).size !== doc.calendars.length
    || new Set(doc.calendars.map(item => item.scheduleID)).size !== doc.calendars.length
    || new Set(doc.calendars.map(item => item.sessionID)).size !== doc.calendars.length) fail()
  for (const item of [...doc.calendars, ...(doc.synchronization?.retiredCalendars ?? [])]) {
    if (item.timeGeneration > doc.timeGeneration || item.role === "reconciliation" && item.slot !== 0) fail()
    if (item.pendingWake && (item.pendingWake.scheduleID !== item.scheduleID || item.pendingWake.run > item.highWater)) fail()
    if (item.wakePreparing && (item.wakePreparing.scheduleID !== item.scheduleID || item.wakePreparing.run !== item.highWater + 1)) fail()
  }
  if (doc.calendars.some(item => item.timeGeneration !== doc.timeGeneration)) fail()
  if (doc.calendarOwner && (doc.calendarOwner.operation.expectedRevision > doc.revision
    || doc.calendarOwner.slots.some(item => item.timeGeneration !== doc.timeGeneration)
    || doc.calendarOwner.retired.some(item => item.descriptor.timeGeneration > doc.timeGeneration))) fail()
  if (doc.fanIn && (doc.fanIn.timeGeneration > doc.timeGeneration || !doc.fanIn.completed && doc.fanIn.timeGeneration !== doc.timeGeneration)) fail()
  const passages = [...doc.history, ...(doc.pending ? [doc.pending] : [])]
  if (new Set(passages.map(item => item.id)).size !== passages.length) fail()
  let previousSettledAt = doc.createdAt
  for (const passage of passages) {
    if (passage.configurationGeneration > doc.configurationGeneration || passage.timeGeneration > doc.timeGeneration
      || passage.createdAt < doc.createdAt || passage.dueAt > passage.createdAt
      || passage.id !== missionDocumentPassageID(doc, passage.configurationGeneration, passage.origin)
      || passage.missionID !== `msn_${stableToken(`${doc.projectID}\0${passage.id}`, 24)}`
      || passage.coordinatorSessionID !== missionCoordinatorSessionID(passage.missionID, passage.createdAt)
      || passage.messageID !== `msg_${stableToken(`${passage.id}\0start`, 40)}`
      || passage.dueAt !== (passage.origin.kind === "wake" ? Math.max(...passage.origin.wakes.map(wake => wake.dueAt)) : passage.createdAt)
      || passage.admittedAt !== null && passage.admittedAt < passage.createdAt
      || passage.manualExpectedRevision !== undefined && passage.origin.kind !== "manual") fail()
    if ("settledAt" in passage) {
      if (passage.settledAt < Math.max(previousSettledAt, passage.createdAt, passage.admittedAt ?? 0)
        || (passage.reason === "not-started") !== (passage.admittedAt === null)
        || passage.reason === "not-started" && passage.outcome !== "failed") fail()
      previousSettledAt = passage.settledAt
    }
  }
  if (doc.pending) {
    const active = doc.pending
    if (active.createdAt < previousSettledAt || active.configurationGeneration !== doc.configurationGeneration
      || active.timeGeneration !== doc.timeGeneration || doc.firstPlayedAt === null
      || active.manualAllowed && active.origin.kind !== "manual") fail()
    if (active.origin.kind === "wake" && active.origin.wakes.some(wake => !doc.calendars.some(item =>
      item.role === "principal" && item.scheduleID === wake.scheduleID && canonicalAuthority(item.pendingWake) === canonicalAuthority(wake)))) fail()
  }
  const retainedLaunches = passages.filter(item => item.admittedAt !== null).length
  if (doc.launchedCount < retainedLaunches || doc.launchedCount > doc.settledCount + (doc.pending?.admittedAt !== null && doc.pending ? 1 : 0)
    + (doc.oneTime?.firstPlay?.admittedAt != null ? 1 : 0)) fail()
  if (doc.oneTime && (doc.configuration.launch.timing.kind !== "immediate" || doc.configuration.launch.condition !== null
    || doc.scheduleActivation || doc.pending || doc.calendars.length
    || doc.id !== `msn_${stableToken(`${doc.projectID}\0${doc.oneTime.creationRequestID}`, 24)}`
    || doc.oneTime.firstPlay && (doc.firstPlayedAt !== doc.oneTime.firstPlay.requestedAt
      || doc.oneTime.firstPlay.operationID !== controlOperationID(doc.id, doc.oneTime.firstPlay.requestID)
      || doc.oneTime.firstPlay.messageID !== controlResumeAdmissionID(doc.oneTime.firstPlay.operationID, doc.oneTime.coordinatorSessionID)
      || doc.oneTime.firstPlay.admittedAt !== null && (doc.launchedCount !== 1 || doc.oneTime.firstPlay.admittedAt < doc.firstPlayedAt!))
    || !doc.oneTime.firstPlay && doc.firstPlayedAt !== null)) fail()
  const play = doc.oneTime?.firstPlay
  if (play) {
    if ((play.admittedAt === null) !== (play.acknowledgement === null)) fail()
    if (play.acknowledgement && (!parseMissionNativeAcknowledgement(play.acknowledgement, {
      missionID: doc.id, operationID: play.operationID, sessionID: doc.oneTime!.coordinatorSessionID, action: "start",
    }) || play.admittedAt !== Math.max(play.requestedAt, play.acknowledgement.admission.time.created))) fail()
  }
  const remembered = new Set([
    ...[...doc.checkpoints, ...(doc.pending?.checkpoints ?? [])].filter(item => item.kind === "conversation-message").map(item => item.key),
    ...doc.configuration.watchedConversationIDs.map(conversationID => missionSourceKey({ kind: "conversation-message", conversationID })),
  ])
  if (remembered.size > 64) fail()
  if (new Set([...doc.checkpoints, ...(doc.pending?.checkpoints ?? [])].map(item => item.key)).size > 64) fail()
  return doc
}

export function missionSourceKey(source: NonNullable<MissionConfiguration["launch"]["condition"]>): string {
  return stableToken(canonicalAuthority(source), 64)
}
export function missionDocumentPassageID(doc: Pick<MissionDocument, "projectID" | "projectCanonical" | "id">,
  configurationGeneration: number, origin: MissionDocumentPending["origin"]): string {
  return `psg_${stableToken(canonicalAuthority([doc.projectID, doc.projectCanonical, doc.id, configurationGeneration, origin]), 40)}`
}

export const missionTombstoneSchema = missionDocumentDeletionIdentitySchema.extend({ version: z.literal(1), id: documentID, projectID: nativeDocumentID,
  projectCanonical: z.string().min(1).max(4096), revision: documentCounter,
  deletedAt: documentTimestamp, timeGeneration: generation }).strict()
export type MissionDocumentTombstone = z.infer<typeof missionTombstoneSchema>
export const missionTombstoneRegistrySchema = z.object({ version: z.literal(1), revision: documentCounter,
  entries: z.array(z.object({ id: documentID, requestID, deletedAt: documentTimestamp }).strict()).max(MISSION_TOMBSTONE_LIMIT)
    .refine(entries => new Set(entries.map(item => item.id)).size === entries.length),
}).strict().refine(value => {
  try { canonicalAuthority(value, MISSION_TOMBSTONE_MAX_BYTES); return true } catch { return false }
}, "Mission tombstone capacity")

export function parseMissionTombstoneRegistry(input: unknown) {
  return missionTombstoneRegistrySchema.parse(JSON.parse(canonicalAuthority(input, MISSION_TOMBSTONE_MAX_BYTES)))
}

export function projectMissionDocument(doc: MissionDocument) {
  const limit = missionLaunchLimit(doc.configuration.launch)
  const lock = doc.deletion ? "deleted" : doc.synchronization || doc.calendarOwner?.operation.pending || doc.fanIn && !doc.fanIn.completed || doc.blocked === "unknown"
    || doc.scheduleActivation && doc.scheduleActivation.state !== "ready" ? "uncertain"
    : doc.state === "stopped" ? "terminal" : doc.pending ? "passage" : doc.state === "finished" ? "terminal"
      : (doc.oneTime?.firstPlay || doc.launchedCount > 0 && !["every", "cron", "multi"].includes(doc.configuration.launch.timing.kind)) ? "launched-once" : null
  return { id: doc.id, revision: doc.revision, state: doc.state, launch: doc.configuration.launch,
    firstPlayedAt: doc.firstPlayedAt, slotEndsAt: doc.slotEndsAt, launchedCount: doc.launchedCount,
    remaining: limit === null ? null : Math.max(0, limit - doc.launchedCount), reserved: !!doc.pending && doc.pending.admittedAt === null,
    everCreatedTask: doc.everCreatedTask, pending: doc.pending ? { id: doc.pending.id, missionID: doc.pending.missionID,
      coordinatorSessionID: doc.pending.coordinatorSessionID, admittedAt: doc.pending.admittedAt } : null,
    latestResult: doc.history.at(-1) ?? null, history: doc.history,
    edit: { structural: lock === null, template: lock === null && !doc.everCreatedTask, reason: lock,
      templateReason: lock ?? (doc.everCreatedTask ? "ever-created-task" : null) },
  }
}
