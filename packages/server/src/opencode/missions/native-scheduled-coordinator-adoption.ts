import { missionLaunchModel, type MissionConfiguration } from "../../missions/launch-policy"
import { MISSION_JOURNAL_STORAGE_PREFIX, type MissionStorage } from "../../missions/journal"
import { MISSION_DOCUMENT_PREFIX, type MissionDocument } from "../../missions/mission-document"
import { stableToken } from "../../missions/receipt-identity"
import type { NativeScheduledPassageContext } from "./native-scheduled-passage-business"
import type { NativeSourceFence } from "./native-source-fence"
import { isReservedMissionScheduleSessionID } from "../../missions/mission-schedule-carrier-identity"
import { NATIVE_SCHEDULE_CARRIER_MARKER } from "./native-schedule-carrier-binding"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { acquireMissionNativeService, type MissionNativeRunner } from "./native-service-adapter"
import { acquireNativePassageObservation } from "./native-passage-observation"
import { acquireNativeSourceFence, ScheduledCoordinatorRefusal } from "./native-source-fence"
import { optionalOrdinaryJournalRange } from "./ordinary-journal-range"

type Author = NonNullable<NonNullable<MissionDocument["creation"]>["author"]>

/** Shared with preparation; the persisted actual author selects agent safeguards. */
export function assertAgentScheduledCoordinatorSelection(configuration: MissionConfiguration, author?: Author) {
  const id = configuration.coordinatorSessionID
  if (!author || !id) return
  if (configuration.watchedConversationIDs.includes(id) || missionLaunchModel(configuration.launch).events.some(event =>
    event.kind === "conversation-message" && event.conversationID === id)) throw new ScheduledCoordinatorRefusal("coordinator-is-source")
}

type AdoptionDocument = Pick<MissionDocument, "id" | "projectID" | "projectCanonical" | "configuration" | "pending">
  & { creation?: Pick<NonNullable<MissionDocument["creation"]>, "author"> }
type Validation = Pick<NativeScheduledPassageContext, "native" | "observation" | "signal" | "current">
  & { document: AdoptionDocument; storage: Pick<MissionStorage, "get" | "scan" | "range">; fence: Pick<NativeSourceFence, "family" | "current">
    & Partial<Pick<NativeSourceFence, "journal" | "coordinator">>; preparing?: true }

export const acquireAgentScheduledCoordinatorValidation = Effect.fn("missions.validateAgentScheduledCoordinator")(function* (
  ctx: Plugin.Context, run: MissionNativeRunner, document: AdoptionDocument, current: () => true, signal: AbortSignal, preparing?: true,
) {
  const configuration = document.pending?.configuration ?? document.configuration
  const author = configuration.coordinatorSelectionAuthor ?? document.creation?.author
  assertAgentScheduledCoordinatorSelection(configuration, author)
  if (!author || !configuration.coordinatorSessionID) return current
  const native = yield* acquireMissionNativeService(current, run).pipe(Effect.scoped)
  const observation = yield* acquireNativePassageObservation(undefined, run)
  const fences = yield* acquireNativeSourceFence(current)
  const range = yield* optionalOrdinaryJournalRange(ctx, run)
  return yield* Effect.tryPromise({ try: () => prepareAgentScheduledCoordinator({ document, native, observation, current, signal, preparing, fence: fences(),
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
    pending: null, creation: { author: input.author } }, input.current, input.signal, true)
})

/** Read-only prevalidation. Its native fence is also consumed inside CAS/effects;
 * the caller's current guard owns the document being changed. */
export async function prepareAgentScheduledCoordinator(input: Validation): Promise<() => true> {
   const doc = input.document, config = doc.pending?.configuration ?? doc.configuration
   const author = config.coordinatorSelectionAuthor ?? doc.creation?.author
  assertAgentScheduledCoordinatorSelection(config, author)
  const id = config.coordinatorSessionID
  if (!author || !id) return input.current
  const { fence, storage } = input
  if (!fence.journal || !fence.coordinator) throw new Error("Agent coordinator validation unavailable")
  const token = stableToken(`${doc.projectID}\0${doc.projectCanonical}`, 24)
  const documents = `${MISSION_DOCUMENT_PREFIX}/project/${token}/missions/`
  fence.journal(`${MISSION_JOURNAL_STORAGE_PREFIX}/${token}${storage.range ? "" : "/"}`, undefined, !!storage.range)
  fence.journal(documents, `${documents}${doc.id}`)
  // Saving records a future selection; it does not adopt or dispatch into the current turn.
  const savingSelf = input.preparing && id === author.coordinatorSessionID
  if (!savingSelf) fence.family(id, undefined, true)
  fence.coordinator(id)
  const session = await input.native.get({ sessionID: id }, { signal: input.signal })
  if (session.id !== id || session.parentID || session.projectID !== doc.projectID
    || session.location.directory !== input.native.location.directory || session.location.workspaceID !== input.native.location.workspaceID
    || isReservedMissionScheduleSessionID(id) || session.metadata?.[NATIVE_SCHEDULE_CARRIER_MARKER] !== undefined)
    throw new ScheduledCoordinatorRefusal("coordinator-owned")
  // A conversation may serve several Missions. A passage running in it when another one
  // starts only delays that start (`adoptNativeScheduledCoordinator`).
  const current = (): true => { input.signal.throwIfAborted(); input.current(); return fence.current() }
  current()
  return current
}
