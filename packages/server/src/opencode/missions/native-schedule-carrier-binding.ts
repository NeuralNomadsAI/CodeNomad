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
import type { NativeScheduleWake } from "./native-schedule-transport-contract"
import { assertNativeScheduleWake, nativeScheduleWakeIdentity, nativeScheduleWakeKey } from "./native-schedule-transport-contract"
import type { NativeScheduleIncarnation } from "./native-schedule-transport-identity"
import { assertNativeScheduleIncarnation } from "./native-schedule-transport-identity"
import { NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"

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

/** Exact session → durable document → current calendar, with no inventory scan. */
export const readNativeScheduleCarrierBinding = (ctx: Context, sessionID: string) => Effect.gen(function* () {
  const session = yield* ctx.session.get({ sessionID: Session.ID.make(sessionID) })
  const raw = session.metadata?.[NATIVE_SCHEDULE_CARRIER_MARKER]
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("schedule-carrier-marker")
  const marker = raw as Record<string, unknown>
  if (typeof marker.missionID !== "string") throw new Error("schedule-carrier-marker")
  const value = yield* ctx.storage.get(nativeScheduleDocumentKey(ctx, marker.missionID))
  const document = parseMissionDocument(value, { id: marker.missionID, projectID: ctx.location.project.id,
    projectCanonical: ctx.location.project.canonical })
  const calendar = document.calendars.find(item => item.sessionID === sessionID)
  if (!calendar || document.deletion || document.synchronization || document.blocked
    || marker.timeGeneration !== document.timeGeneration || marker.role !== calendar.role || marker.slot !== calendar.slot
    || session.parentID || session.projectID !== document.projectID || session.location.directory !== ctx.location.directory
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

/** One durable unresolved dispatch slot per Mission. Public KV publication is
 * serialized with document mutations across bundle incarnations in this service.
 * Native SQL CAS in the receiver owns high-water advancement. */
export function claimNativeScheduleCarrierWake(ctx: Context, wake: NativeScheduleWake, incarnation: NativeScheduleIncarnation,
  run: Run, current: () => true): Promise<boolean> {
  return runMissionExclusive(`document-mutation:${nativeScheduleProjectToken(ctx)}`, async () => {
    assertNativeScheduleWake(wake)
    current()
    const binding = await run(readNativeScheduleCarrierBinding(ctx, wake.sessionID))
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
