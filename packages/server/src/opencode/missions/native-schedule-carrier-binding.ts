import { createHash } from "node:crypto"
import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { runMissionExclusive } from "../../missions/exclusive"
import { MISSION_DOCUMENT_PREFIX, parseMissionDocument, type MissionCalendar, type MissionDocument } from "../../missions/mission-document"
import { stableToken } from "../../missions/receipt-identity"
import type { MissionDocumentMutation } from "../../missions/mission-document-store"
import type { NativeScheduleWake } from "./native-schedule-transport-contract"
import { assertNativeScheduleWake, nativeScheduleWakeIdentity, nativeScheduleWakeKey } from "./native-schedule-transport-contract"
import type { NativeScheduleIncarnation } from "./native-schedule-transport-identity"
import { assertNativeScheduleIncarnation } from "./native-schedule-transport-identity"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { z } from "zod"
import { documentCounter, documentID, nativeDocumentID, MISSION_DOCUMENT_MAX_BYTES } from "../../missions/launch-policy"

export const NATIVE_SCHEDULE_CARRIER_MARKER = "codenomad.schedule-carrier"
export const NATIVE_SCHEDULE_CARRIER_SIGNAL = "CODENOMAD_MISSION_SCHEDULE_WAKE"
export type NativeScheduleCarrierArtifact = { file: string; sha256: string }
export type NativeScheduleCarrierInstallation = {
  registrationFile: string; provider: NativeScheduleCarrierArtifact; runtime: NativeScheduleCarrierArtifact
}
export type NativeScheduleCarrierBinding = { document: MissionDocument; calendar: MissionCalendar }
type Context = Pick<Plugin.Context, "session" | "storage" | "location">
type Run = <A>(effect: Effect.Effect<A, unknown>) => Promise<A>
type Claim = { version: 1; key: string; wake: NativeScheduleWake; incarnation: NativeScheduleIncarnation;
  settled?: { revision: number; highWater: number } }

export function assertNativeScheduleCarrierArtifacts(installation: NativeScheduleCarrierInstallation): true {
  if (!path.isAbsolute(installation.registrationFile)) throw new Error("schedule-registration-path")
  for (const artifact of [installation.provider, installation.runtime]) {
    if (!path.isAbsolute(artifact.file) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("schedule-carrier-artifact")
    const fd = openSync(artifact.file, "r")
    try {
      const stat = fstatSync(fd), maximum = 8 * 1024 * 1024
      if (!stat.isFile() || stat.size > maximum) throw new Error("schedule-carrier-artifact")
      const bytes = Buffer.alloc(stat.size + 1)
      let size = 0
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null)
        if (!count) break
        size += count
      }
      if (size !== stat.size || createHash("sha256").update(bytes.subarray(0, size)).digest("hex") !== artifact.sha256)
        throw new Error("schedule-carrier-artifact")
    } finally { closeSync(fd) }
  }
  return true
}

export function nativeScheduleDocumentKey(ctx: Pick<Context, "location">, id: string) {
  if (!/^[A-Za-z0-9_-]{3,100}$/.test(id)) throw new Error("schedule-carrier-mission")
  return `${MISSION_DOCUMENT_PREFIX}/project/${nativeScheduleProjectToken(ctx)}/missions/${id}`
}
export const nativeScheduleProjectToken = (ctx: Pick<Context, "location">) =>
  stableToken(`${ctx.location.project.id}\0${ctx.location.project.canonical}`, 24)
export const nativeScheduleClaimKey = (ctx: Pick<Context, "location">, missionID: string) =>
  `${MISSION_DOCUMENT_PREFIX}/transport/${nativeScheduleProjectToken(ctx)}/${missionID}`
export const nativeScheduleCarrierLookupKey = (ctx: Pick<Context, "location">, sessionID: string) =>
  `${MISSION_DOCUMENT_PREFIX}/carriers/${nativeScheduleProjectToken(ctx)}/${nativeDocumentID.parse(sessionID)}`
export const nativeScheduleCarrierReferenceSchema = z.object({ missionID: documentID, timeGeneration: documentCounter.positive(),
  role: z.enum(["principal", "reconciliation"]), slot: documentCounter.max(7),
}).strict().refine(value => value.role !== "reconciliation" || value.slot === 0)
export type NativeScheduleCarrierReference = z.infer<typeof nativeScheduleCarrierReferenceSchema>
export type NativeScheduleCarrierOwnership = { reference: NativeScheduleCarrierReference; verified: boolean; document?: MissionDocument }
const carrierMember = (doc: MissionDocument, sessionID: string, reference: NativeScheduleCarrierReference) =>
  [...doc.calendars, ...(doc.synchronization?.retiredCalendars ?? []), ...(doc.calendarOwner?.slots ?? []),
    ...(doc.calendarOwner?.retired.map(item => item.descriptor) ?? [])].some(item => item.sessionID === sessionID
      && item.timeGeneration === reference.timeGeneration && item.role === reference.role && item.slot === reference.slot)

/** Technical ownership survives controls and missing/altered markers. An indexed
 * but unverifiable target stays protected; only verified ownership may execute. */
export const readNativeScheduleCarrierOwnership = (ctx: Context, sessionID: string) => Effect.gen(function* () {
  const indexed = yield* ctx.storage.get(nativeScheduleCarrierLookupKey(ctx, sessionID))
  const index = indexed === undefined ? undefined : nativeScheduleCarrierReferenceSchema.parse(indexed)
  const session = yield* ctx.session.get({ sessionID: Session.ID.make(sessionID) }).pipe(Effect.catch(error =>
    error && typeof error === "object" && "_tag" in error && error._tag === "Session.NotFoundError" ? Effect.succeed(undefined) : Effect.fail(error)))
  if (!session) return index ? { reference: index, verified: false } : undefined
  const marker = nativeScheduleCarrierReferenceSchema.safeParse(session.metadata?.[NATIVE_SCHEDULE_CARRIER_MARKER])
  const reference = index ?? (marker.success ? marker.data : undefined)
  if (!reference) return undefined
  let doc: MissionDocument
  try { doc = parseMissionDocument(yield* ctx.storage.get(nativeScheduleDocumentKey(ctx, reference.missionID)), {
    id: reference.missionID, projectID: ctx.location.project.id, projectCanonical: ctx.location.project.canonical,
  }) } catch { return index ? { reference, verified: false } : undefined }
  if (!carrierMember(doc, sessionID, reference)) return index ? { reference, verified: false } : undefined
  const verified = !!index && marker.success && canonicalAuthority(marker.data) === canonicalAuthority(reference)
    && session.id === sessionID && !session.parentID && session.projectID === doc.projectID
    && session.location.directory === ctx.location.directory && session.location.workspaceID === ctx.location.workspaceID
    && doc.configuration.roots.some(root => root.directory === session.location.directory)
    && session.model?.providerID === NATIVE_SCHEDULE_CARRIER_MODEL.providerID && session.model.id === NATIVE_SCHEDULE_CARRIER_MODEL.id
  return { reference, document: doc, verified } satisfies NativeScheduleCarrierOwnership
})

export async function registerNativeScheduleCarrierLookupLocked(ctx: Context, sessionID: string, reference: NativeScheduleCarrierReference,
  run: Run, current: () => true, locked: MissionDocumentMutation): Promise<void> {
  locked.assertActive(); current()
  if (locked.projectToken !== nativeScheduleProjectToken(ctx)) throw new Error("schedule-carrier-index-project")
  const ref = nativeScheduleCarrierReferenceSchema.parse(reference), doc = await locked.read(ref.missionID)
  if (!doc || "deletedAt" in doc || !carrierMember(doc, sessionID, ref)) throw new Error("schedule-carrier-index-intent")
  const key = nativeScheduleCarrierLookupKey(ctx, sessionID), previous = await run(ctx.storage.get(key))
  if (previous !== undefined && canonicalAuthority(nativeScheduleCarrierReferenceSchema.parse(previous)) !== canonicalAuthority(ref))
    throw new Error("schedule-carrier-index-conflict")
  locked.assertActive(); current()
  if (previous === undefined) await run(ctx.storage.set(key, ref))
  if (canonicalAuthority(await run(ctx.storage.get(key))) !== canonicalAuthority(ref)) throw new Error("schedule-carrier-index-uncertain")
  locked.assertActive(); current()
}

export async function removeNativeScheduleCarrierLookupLocked(ctx: Context, sessionID: string, reference: NativeScheduleCarrierReference,
  run: Run, current: () => true, locked: MissionDocumentMutation): Promise<void> {
  locked.assertActive(); current()
  if (locked.projectToken !== nativeScheduleProjectToken(ctx)) throw new Error("schedule-carrier-index-project")
  const doc = await locked.read(reference.missionID)
  const removed = doc && !("deletedAt" in doc) && doc.calendarOwner?.retired.find(item => item.descriptor.sessionID === sessionID
    && item.descriptor.timeGeneration === reference.timeGeneration && item.sessionRemoved)
  if (!removed) throw new Error("schedule-carrier-cleanup-unconfirmed")
  const key = nativeScheduleCarrierLookupKey(ctx, sessionID), previous = await run(ctx.storage.get(key))
  if (previous !== undefined && canonicalAuthority(nativeScheduleCarrierReferenceSchema.parse(previous)) !== canonicalAuthority(reference))
    throw new Error("schedule-carrier-index-conflict")
  locked.assertActive(); current()
  if (previous !== undefined) await run(ctx.storage.remove(key))
  if (await run(ctx.storage.get(key)) !== undefined) throw new Error("schedule-carrier-index-uncertain")
  locked.assertActive(); current()
}

/** Exact session → durable document → current calendar, with no inventory scan. */
export const readNativeScheduleCarrierBinding = (ctx: Context, sessionID: string, auxiliaryIntent?: NativeScheduleCarrierBinding) => Effect.gen(function* () {
  const session = yield* ctx.session.get({ sessionID: Session.ID.make(sessionID) })
  const raw = session.metadata?.[NATIVE_SCHEDULE_CARRIER_MARKER]
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("schedule-carrier-marker")
  const marker = raw as Record<string, unknown>
  if (typeof marker.missionID !== "string") throw new Error("schedule-carrier-marker")
  const value = yield* ctx.storage.get(nativeScheduleDocumentKey(ctx, marker.missionID))
  const document = parseMissionDocument(value, { id: marker.missionID, projectID: ctx.location.project.id,
    projectCanonical: ctx.location.project.canonical })
  let calendar = document.calendars.find(item => item.sessionID === sessionID)
  if (!calendar && auxiliaryIntent) {
    const ownership = yield* readNativeScheduleCarrierOwnership(ctx, sessionID)
    const slot = document.calendarOwner?.slots.find(item => item.sessionID === sessionID && item.role === "reconciliation"
      && item.timeGeneration === document.timeGeneration && item.creation !== "prepared" && !item.ambiguous.length)
    const candidate = auxiliaryIntent.calendar
    if (ownership?.verified && slot && candidate.role === "reconciliation" && candidate.slot === slot.slot
      && candidate.timeGeneration === slot.timeGeneration && candidate.sessionID === slot.sessionID
      && (slot.scheduleID === null || slot.scheduleID === candidate.scheduleID) && candidate.highWater === 0 && !candidate.pendingWake && !candidate.wakePreparing
      && canonicalAuthority(auxiliaryIntent.document, MISSION_DOCUMENT_MAX_BYTES) === canonicalAuthority(document, MISSION_DOCUMENT_MAX_BYTES)) calendar = candidate
  }
  const auxiliary = calendar?.role === "reconciliation" && (!document.calendarOwner || document.calendarOwner.slots.some(slot => slot.role === "reconciliation"
    && slot.sessionID === sessionID && slot.timeGeneration === document.timeGeneration && (slot.scheduleID === calendar?.scheduleID || auxiliaryIntent && slot.scheduleID === null)))
  if (auxiliary && document.calendarOwner && !(yield* readNativeScheduleCarrierOwnership(ctx, sessionID))?.verified) throw new Error("schedule-carrier-ownership")
  if (!calendar || !auxiliary && (document.deletion || document.synchronization || document.blocked || calendar.role === "reconciliation")
    || marker.timeGeneration !== document.timeGeneration || marker.role !== calendar.role || marker.slot !== calendar.slot
    || session.id !== sessionID || session.parentID || session.projectID !== document.projectID || session.location.directory !== ctx.location.directory
    || session.location.workspaceID !== ctx.location.workspaceID || !document.configuration.roots.some(root => root.directory === session.location.directory)
    || session.model?.providerID !== NATIVE_SCHEDULE_CARRIER_MODEL.providerID || session.model.id !== NATIVE_SCHEDULE_CARRIER_MODEL.id)
    throw new Error("schedule-carrier-ownership")
  return { document, calendar } satisfies NativeScheduleCarrierBinding
})

async function readClaim(ctx: Context, missionID: string, run: Run): Promise<Claim | undefined> {
  const raw = await run(ctx.storage.get(nativeScheduleClaimKey(ctx, missionID)))
  if (raw === undefined) return undefined
  canonicalAuthority(raw, 32 * 1024)
  const claim = raw as unknown as Claim
  if (!claim || claim.version !== 1) throw new Error("schedule-claim-invalid")
  assertNativeScheduleWake(claim.wake)
  assertNativeScheduleIncarnation(claim.incarnation)
  if (claim.wake.missionID !== missionID || claim.key !== nativeScheduleWakeKey(claim.wake)
    || claim.settled !== undefined && (!claim.settled || !Number.isSafeInteger(claim.settled.revision) || claim.settled.revision < 0
      || !Number.isSafeInteger(claim.settled.highWater) || claim.settled.highWater < claim.wake.run)) throw new Error("schedule-claim-invalid")
  return claim
}

async function publishClaim(ctx: Context, claim: Claim, run: Run, current: () => true) {
  const key = nativeScheduleClaimKey(ctx, claim.wake.missionID), bytes = canonicalAuthority(claim, 32 * 1024)
  current()
  await run(ctx.storage.set(key, claim))
  if (canonicalAuthority(await run(ctx.storage.get(key)), 32 * 1024) !== bytes) throw new Error("schedule-claim-uncertain")
  current()
}

/** Caller holds the document-mutation exclusion. Preserve one monotone closure
 * on this exact claim before its high-water mapping can leave the document. */
async function closeClaim(ctx: Context, doc: MissionDocument, claim: Claim, run: Run, current: () => true): Promise<boolean> {
  if (claim.settled) return claim.settled.revision <= doc.revision && claim.wake.generation <= doc.timeGeneration
  const calendar = [...doc.calendars, ...(doc.synchronization?.retiredCalendars ?? [])].find(item =>
    item.scheduleID === claim.wake.scheduleID && item.sessionID === claim.wake.sessionID && item.timeGeneration === claim.wake.generation)
  if (!calendar || calendar.highWater < claim.wake.run) return false
  await publishClaim(ctx, { ...claim, settled: { revision: doc.revision, highWater: calendar.highWater } }, run, current)
  return true
}

/** Close only from an authoritative current/retiring calendar high-water. Call
 * after settlement and before discarding mappings; absent proof keeps the hold. */
export function closeNativeScheduleCarrierClaim(ctx: Context, missionID: string, run: Run, current: () => true): Promise<boolean> {
  return runMissionExclusive(`document-mutation:${nativeScheduleProjectToken(ctx)}`, async () => {
    current()
    const doc = parseMissionDocument(await run(ctx.storage.get(nativeScheduleDocumentKey(ctx, missionID))), {
      id: missionID, projectID: ctx.location.project.id, projectCanonical: ctx.location.project.canonical,
    })
    const claim = await readClaim(ctx, missionID, run)
    current()
    return !claim || closeClaim(ctx, doc, claim, run, current)
  })
}

/** Calendar owners already hold the store exclusion across intent/native I/O.
 * This port closes the same receipt without re-entering that exclusion. */
export async function closeNativeScheduleCarrierClaimLocked(ctx: Context, missionID: string, run: Run,
  current: () => true, locked: MissionDocumentMutation): Promise<boolean> {
  const guard = (): true => {
    locked.assertActive()
    if (locked.projectToken !== nativeScheduleProjectToken(ctx)) throw new Error("schedule-claim-exclusion")
    return current()
  }
  guard()
  const doc = await locked.read(missionID)
  if (!doc || "deletedAt" in doc) throw new Error("schedule-claim-document")
  const claim = await readClaim(ctx, missionID, run)
  guard()
  return !claim || closeClaim(ctx, doc, claim, run, guard)
}

/** One durable unresolved dispatch slot per Mission. Public KV publication is
 * serialized with document mutations across bundle incarnations in this service.
 * Native SQL CAS in the receiver owns high-water advancement. */
export function claimNativeScheduleCarrierWake(ctx: Context, wake: NativeScheduleWake, incarnation: NativeScheduleIncarnation,
  run: Run, current: () => true, readAuxiliaryIntent?: () => Promise<NativeScheduleCarrierBinding | undefined>): Promise<boolean> {
  return runMissionExclusive(`document-mutation:${nativeScheduleProjectToken(ctx)}`, async () => {
    assertNativeScheduleWake(wake)
    current()
    // Only a trusted read-only native RPC preflight supplies this resolver. The
    // exact current intent/document is rechecked under exclusion before dispatch.
    const auxiliaryIntent = await readAuxiliaryIntent?.()
    current()
    const binding = await run(readNativeScheduleCarrierBinding(ctx, wake.sessionID, auxiliaryIntent))
    if (!binding || binding.document.id !== wake.missionID || binding.document.timeGeneration !== wake.generation
      || binding.calendar.scheduleID !== wake.scheduleID || binding.calendar.highWater >= wake.run) return false
    const previous = await readClaim(ctx, wake.missionID, run)
    if (previous) {
      if (previous.key === nativeScheduleWakeKey(wake)) return false
      if (!await closeClaim(ctx, binding.document, previous, run, current)) return false
    }
    await publishClaim(ctx, { version: 1, key: nativeScheduleWakeKey(wake), wake: nativeScheduleWakeIdentity(wake), incarnation }, run, current)
    return true
  })
}

/** The authorized ordinary-input boundary supplies its authoritative mapping
 * check even if a privileged native client edited the session marker. */
export function assertOrdinaryMissionScheduleInput(input: { ownedCarrier: boolean; sessionMetadata?: Record<string, unknown>; metadata?: Record<string, unknown> }): true {
  if (input.ownedCarrier || input.sessionMetadata?.[NATIVE_SCHEDULE_CARRIER_MARKER] !== undefined
    || input.metadata?.schedule !== undefined || input.metadata?.[NATIVE_SCHEDULE_CARRIER_MARKER] !== undefined)
    throw new Error("schedule-carrier-ordinary-input")
  return true
}
