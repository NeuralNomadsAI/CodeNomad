import { canonicalAuthority } from "../../missions/authority-protocol"
import { missionLaunchModel, type MissionConfiguration } from "../../missions/launch-policy"
import { MissionJournal, MISSION_JOURNAL_STORAGE_PREFIX, type MissionStorage } from "../../missions/journal"
import { MISSION_DOCUMENT_PREFIX, parseMissionDocument, missionTombstoneSchema, type MissionDocument } from "../../missions/mission-document"
import { stableToken } from "../../missions/receipt-identity"
import { MAX_CONTROL_FAMILY_SESSIONS } from "../../missions/native-session-family"
import type { NativeMissionSession } from "../../missions/control-types"
import type { NativeScheduledPassageContext } from "./native-scheduled-passage-business"
import type { NativeSourceFence } from "./native-source-fence"
import { scheduledPassageOwner } from "./native-scheduled-passage-owner"
import { isReservedMissionScheduleSessionID } from "../../missions/mission-schedule-carrier-identity"
import { NATIVE_SCHEDULE_CARRIER_MARKER } from "./native-schedule-carrier-binding"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { acquireMissionNativeService, type MissionNativeRunner } from "./native-service-adapter"
import { acquireNativePassageObservation } from "./native-passage-observation"
import { acquireNativeSourceFence } from "./native-source-fence"
import { optionalOrdinaryJournalRange } from "./ordinary-journal-range"

type Author = NonNullable<NonNullable<MissionDocument["creation"]>["author"]>

/** Shared with preparation; the persisted actual author selects agent safeguards. */
export function assertAgentScheduledCoordinatorSelection(configuration: MissionConfiguration, author?: Author) {
  const id = configuration.coordinatorSessionID
  if (!author || !id) return
  if (id === author.coordinatorSessionID) throw new Error("coordinator-is-author")
  if (configuration.watchedConversationIDs.includes(id) || missionLaunchModel(configuration.launch).events.some(event =>
    event.kind === "conversation-message" && event.conversationID === id)) throw new Error("coordinator-is-source")
}

type AdoptionDocument = Pick<MissionDocument, "id" | "projectID" | "projectCanonical" | "configuration" | "pending">
  & { creation?: Pick<NonNullable<MissionDocument["creation"]>, "author"> }
type Validation = Pick<NativeScheduledPassageContext, "native" | "observation" | "signal" | "current">
  & { document: AdoptionDocument; storage: Pick<MissionStorage, "get" | "scan" | "range">; fence: Pick<NativeSourceFence, "family" | "current">
    & Partial<Pick<NativeSourceFence, "journal" | "coordinator">> }

export const acquireAgentScheduledCoordinatorValidation = Effect.fn("missions.validateAgentScheduledCoordinator")(function* (
  ctx: Plugin.Context, run: MissionNativeRunner, document: AdoptionDocument, current: () => true, signal: AbortSignal,
) {
   const configuration = document.pending?.configuration ?? document.configuration
   const author = configuration.coordinatorSelectionAuthor ?? document.creation?.author
   assertAgentScheduledCoordinatorSelection(configuration, author)
   if (!author || !configuration.coordinatorSessionID) return current
  const native = yield* acquireMissionNativeService(current, run).pipe(Effect.scoped)
  const observation = yield* acquireNativePassageObservation(undefined, run)
  const fences = yield* acquireNativeSourceFence(current)
  const range = yield* optionalOrdinaryJournalRange(ctx, run)
  return yield* Effect.tryPromise({ try: () => prepareAgentScheduledCoordinator({ document, native, observation, current, signal, fence: fences(),
    storage: { range, get: key => run(ctx.storage.get(key)) as ReturnType<MissionStorage["get"]>,
      scan: value => run(ctx.storage.scan(value)) as ReturnType<MissionStorage["scan"]> } }), catch: error => error })
})

/** Creation consumes the returned synchronous guard in its document CAS. */
export const prevalidateAgentScheduledCoordinatorCreation = Effect.fn("missions.prevalidateAgentScheduledCoordinatorCreation")(function* (
  ctx: Plugin.Context, run: MissionNativeRunner, input: {
    missionID: string; configuration: MissionConfiguration; author?: Author; current(): true; signal: AbortSignal
  },
) {
  return yield* acquireAgentScheduledCoordinatorValidation(ctx, run, { id: input.missionID, configuration: input.configuration,
    projectID: ctx.location.project.id, projectCanonical: ctx.location.project.canonical,
    pending: null, creation: { author: input.author } }, input.current, input.signal)
})

/** Read-only prevalidation. Its native fence is also consumed inside CAS/effects;
 * the caller's current guard owns the document being changed. */
export async function prepareAgentScheduledCoordinator(input: Validation): Promise<() => true> {
   const doc = input.document, config = doc.pending?.configuration ?? doc.configuration
   const author = config.coordinatorSelectionAuthor ?? doc.creation?.author
  assertAgentScheduledCoordinatorSelection(config, author)
  const id = config.coordinatorSessionID
  if (!author || !id) return input.current
  const { fence, observation, storage } = input
  if (!fence.journal || !fence.coordinator) throw new Error("Agent coordinator validation unavailable")
  const token = stableToken(`${doc.projectID}\0${doc.projectCanonical}`, 24)
  const documents = `${MISSION_DOCUMENT_PREFIX}/project/${token}/missions/`
  fence.journal(`${MISSION_JOURNAL_STORAGE_PREFIX}/${token}${storage.range ? "" : "/"}`, undefined, !!storage.range)
  fence.journal(documents, `${documents}${doc.id}`)
  fence.family(id, undefined, true)
  fence.coordinator(id)
  const session = await input.native.get({ sessionID: id }, { signal: input.signal })
  if (session.id !== id || session.parentID || session.projectID !== doc.projectID
    || session.location.directory !== input.native.location.directory || session.location.workspaceID !== input.native.location.workspaceID
    || isReservedMissionScheduleSessionID(id) || session.metadata?.[NATIVE_SCHEDULE_CARRIER_MARKER] !== undefined)
    throw new Error("Existing coordinator identity differs")
  const family = [id], seen = new Set(family)
  for (let index = 0; index < family.length; index++) {
    input.signal.throwIfAborted(); input.current()
    const state = await observation.session(family[index])
    if (state.active || state.inbox || state.suspended || state.runningTools) throw new Error("coordinator-busy")
    for (const child of await observation.children(family[index])) {
      if (seen.has(child) || seen.size >= MAX_CONTROL_FAMILY_SESSIONS) throw new Error("Coordinator family coverage unavailable")
      seen.add(child); family.push(child)
    }
  }
  if (await observation.requests(family)) throw new Error("coordinator-busy")
  const journal = new MissionJournal({ ...storage, set: async () => { throw new Error("Coordinator validation is read-only") } },
    doc.projectID, doc.projectCanonical)
  const snapshot = await journal.snapshot()
  if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable
    || snapshot.missions.some(mission => mission.id !== doc.pending?.missionID
      && (mission.status === "active" || mission.control?.pending.length || mission.control?.receipts?.some(receipt => receipt.acknowledgementState === "unknown"))
      && (seen.has(mission.coordinatorSessionId) || mission.actors.some(actor => seen.has(actor.sessionId))))) throw new Error("coordinator-owned")
  let after: string | undefined, count = 0
  do {
    const page = await storage.scan({ prefix: documents, after, limit: 100 })
    for (const entry of page.entries) {
      if (++count > 2036) throw new Error("Coordinator ownership coverage unavailable")
      const identity = { projectID: doc.projectID, projectCanonical: doc.projectCanonical, id: entry.key.slice(documents.length) }
      if (identity.id === doc.id) continue
      const value = entry.value && typeof entry.value === "object" && "deletedAt" in entry.value
        ? missionTombstoneSchema.parse(entry.value) : parseMissionDocument(entry.value, identity)
      if (value.id !== identity.id || value.projectID !== doc.projectID || value.projectCanonical !== doc.projectCanonical)
        throw new Error("coordinator-owned")
      if (!("deletedAt" in value) && (value.pending && seen.has(value.pending.coordinatorSessionID)
        || value.preparation?.pending && [value.preparation.previousSessionID, value.preparation.coordinatorSessionID].some(actor => seen.has(actor))
        || value.oneTime && seen.has(value.oneTime.coordinatorSessionID) && (!["finished", "stopped"].includes(value.state)
          || value.oneTime.firstPlay && !value.oneTime.firstPlay.acknowledgement)))
        throw new Error("coordinator-owned")
    }
    if (page.next && (page.next === after || !page.entries.length)) throw new Error("Coordinator ownership coverage unavailable")
    after = page.next
  } while (after)
  await validateMarker(session)
  const current = (): true => { input.signal.throwIfAborted(); input.current(); return fence.current() }
  current()
  return current

  async function validateMarker(session: NativeMissionSession) {
    const raw = session.metadata?.["codenomad.mission"]
    if (raw === undefined) return
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("coordinator-owned")
    const marker = raw as { missionID?: string; document?: { missionID?: string; passageID?: string; coordinatorReused?: unknown } }
    if (doc.pending && canonicalAuthority(raw) === canonicalAuthority({ version: 1, missionID: doc.pending.missionID,
      kind: "coordinator", role: "coordinator", document: { missionID: doc.id, passageID: doc.pending.id, coordinatorReused: true } })) return
    if (marker.document) {
      try {
        const owner = await storage.get(`${documents}${marker.document.missionID}`)
        if (!scheduledPassageOwner(owner, doc, id!, marker)) return
      } catch { /* Unknown ownership refuses adoption. */ }
      throw new Error("coordinator-owned")
    }
    const owner = snapshot.missions.find(mission => mission.id === marker.missionID)
    if (!owner || owner.status === "active" || owner.control?.pending.length
      || owner.control?.receipts?.some(receipt => receipt.acknowledgementState === "unknown")
      || !owner.actors.some(actor => actor.sessionId === id)) throw new Error("coordinator-owned")
  }
}
