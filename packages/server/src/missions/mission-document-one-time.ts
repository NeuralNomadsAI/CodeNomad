import { canonicalAuthority } from "./authority-protocol"
import { MissionControlError, MissionCreateNoEffectError } from "./control-error"
import type { MissionCreateInput, MissionProject } from "./control-types"
import type { MissionLifecycleInput, MissionNativeAcknowledgement } from "./lifecycle-model"
import type { MissionDocument } from "./mission-document"
import type { NativeMissionDocumentStore } from "./mission-document-store"
import type { MissionMap } from "./model"
import { controlOperationID, controlResumeAdmissionID, stableToken } from "./receipt-identity"
import { parseMissionNativeAcknowledgement } from "./lifecycle-schema"
import { isDeepStrictEqual } from "node:util"
import { missionSlotEndsAt } from "./launch-policy"
import { documentPassageSources, documentSourceStartText } from "./mission-document-passage-input"
import type { QualifiedDocumentSourceSnapshot } from "../opencode/missions/native-scheduled-passage-sources"

/** The owner keeps every operation inside its current native invocation graph. */
export type MissionDocumentSources = (document: MissionDocument, current: () => true) => Promise<QualifiedDocumentSourceSnapshot>
export type MissionDocumentAccess = <T>(use: (store: NativeMissionDocumentStore, sources?: MissionDocumentSources) => Promise<T>) => Promise<T>

export async function requireMissionOneTimeDocument(access: MissionDocumentAccess, id: string, coordinatorSessionID: string, input?: MissionCreateInput) {
  return access(async store => {
    const doc = await store.read(id)
    if (!doc) return undefined
    if ("deletedAt" in doc || !doc.oneTime || doc.oneTime.coordinatorSessionID !== coordinatorSessionID
      && !(doc.preparation?.pending && doc.preparation.coordinatorSessionID === coordinatorSessionID))
      throw new MissionControlError("Unified Mission document unavailable; existing data is retained", "document-unavailable")
    if (input && (doc.oneTime.creationRequestID !== input.requestID
      || doc.oneTime.creationDigest !== stableToken(canonicalAuthority(JSON.parse(JSON.stringify(input))), 64)))
      throw new MissionCreateNoEffectError(input.requestID, id)
    if (!input && doc.preparation?.pending) throw new MissionControlError("Original Mission preparation is unresolved", "control-pending")
    if (!input && doc.dormantJournal) throw new MissionControlError("Mission calendar owns this preparation", "control-pending")
    return doc
  })
}

export async function prepareMissionOneTimeDocument(access: MissionDocumentAccess, project: MissionProject,
  id: string, input: MissionCreateInput, coordinatorSessionID: string, createdAt: number, current: () => true): Promise<MissionDocument> {
  const digest = stableToken(canonicalAuthority(JSON.parse(JSON.stringify(input))), 64)
  return access(async store => {
    const previous = await store.read(id)
    if (previous) {
      if ("deletedAt" in previous) throw new MissionControlError("Mission deleted", "mission-deleted")
      if (previous.oneTime?.creationRequestID !== input.requestID || previous.oneTime.creationDigest !== digest)
        throw new MissionCreateNoEffectError(input.requestID, id)
      return previous
    }
    const location = input.expectedCoordinatorLocation ?? project.location
    return store.create(id, { title: input.title ?? input.objective.trim().replace(/\s+/g, " ").slice(0, 60),
      objective: input.objective, ...(input.notes === undefined ? {} : { notes: input.notes }), template: input.template,
      ...(input.profiles === undefined ? {} : { profiles: input.profiles }), taskMode: input.taskMode ?? "native",
      // One-time admission resolves the owning backend/profile afresh at each send.
      profileID: null, executionHost: null, roots: [{ mode: "directory-only", directory: location.directory }], watchedConversationIDs: [],
      launch: { timing: { kind: "immediate" }, condition: null, ends: { maxLaunches: null, afterMs: null, at: null } },
    }, createdAt, current, { creationRequestID: input.requestID, creationDigest: digest,
      coordinatorSessionID, location: { ...location }, firstPlay: null })
  })
}

export async function prepareMissionOneTimeControl(access: MissionDocumentAccess, mission: MissionMap, input: MissionLifecycleInput, at: number, current: () => true) {
  return access(async (store, sources) => store.withExclusion(async store => {
    const doc = await store.read(mission.id)
    if (!doc) return
    if ("deletedAt" in doc || !doc.oneTime || doc.oneTime.coordinatorSessionID !== mission.coordinatorSessionId)
      throw new MissionControlError("Mission document binding unavailable", "control-pending")
    const play = doc.oneTime.firstPlay
    if (input.action === "start" && play && play.admittedAt === null
      && (play.requestID !== input.requestID || play.expectedRevision !== input.expectedRevision))
      throw new MissionControlError("Original first Play is unresolved", "control-pending")
    if (input.action === "start" && !play) {
      if (doc.state !== "paused" || doc.scheduleActivation || doc.deletion) throw new MissionControlError("Mission cannot Play", "control-conflict")
      let snapshot: QualifiedDocumentSourceSnapshot | undefined, inputText: string | undefined
      if (doc.configuration.watchedConversationIDs.length) {
        if (!sources) throw new MissionControlError("Followed conversation context unavailable; check sources before Play", "control-pending")
        try {
          snapshot = await sources(doc, () => { store.assertActive(); return current() })
          inputText = documentSourceStartText(doc.configuration.objective, documentPassageSources({ pending: {
            configuration: doc.configuration, checkpoints: snapshot.checkpoints } }))
        } catch { throw new MissionControlError("Followed conversation context is incomplete, moved or exceeds launch capacity; check sources before Play", "control-pending") }
      }
      await store.change(doc.id, doc.revision, () => { snapshot?.current(); return current() }, next => {
        next.firstPlayedAt = Math.max(at, next.createdAt)
        next.slotEndsAt = missionSlotEndsAt(next.configuration.launch, next.firstPlayedAt)
        if (next.slotEndsAt !== null && next.slotEndsAt < next.firstPlayedAt) throw new MissionControlError("Mission slot end has passed", "control-conflict")
        next.state = "running"
        const operationID = controlOperationID(mission.id, input.requestID)
        next.oneTime!.firstPlay = { requestID: input.requestID, expectedRevision: input.expectedRevision, operationID,
          messageID: controlResumeAdmissionID(operationID, mission.coordinatorSessionId), requestedAt: next.firstPlayedAt,
          admittedAt: null, acknowledgement: null, ...(inputText === undefined ? {} : { inputText }) }
      }, snapshot?.revalidate)
    } else {
      const state = input.action === "stop" ? "stopped" : input.action === "pause" ? "paused" : "running"
      if (doc.state !== state) await store.change(doc.id, doc.revision, current, next => { next.state = state })
    }
  }, { wait: false }))
}

export async function missionOneTimeStartText(access: MissionDocumentAccess, mission: MissionMap, operationID: string) {
  const doc = await requireMissionOneTimeDocument(access, mission.id, mission.coordinatorSessionId)
  const play = doc?.oneTime?.firstPlay
  return play?.operationID === operationID ? play.inputText : undefined
}

export async function acknowledgeMissionOneTimeControl(access: MissionDocumentAccess, mission: MissionMap, acknowledgement: MissionNativeAcknowledgement, current: () => true) {
  if (acknowledgement.disposition !== "start-admitted" || acknowledgement.sessionID !== mission.coordinatorSessionId) return
  await access(async store => {
    const doc = await store.read(mission.id)
    if (!doc) return
    if ("deletedAt" in doc || !doc.oneTime) throw new MissionControlError("Mission document unavailable", "control-pending")
    const play = doc.oneTime.firstPlay
    if (!play || play.operationID !== acknowledgement.operationID) return // A resumed turn keeps the original launch count.
    const validated = parseMissionNativeAcknowledgement(acknowledgement, { missionID: mission.id,
      operationID: play.operationID, sessionID: doc.oneTime.coordinatorSessionID, action: "start" })
    if (validated?.disposition !== "start-admitted" || play.messageID !== validated.admission.id)
      throw new MissionControlError("Mission admission identity changed", "control-pending")
    if (play.inputText !== undefined && validated.admission.payload.text !== play.inputText)
      throw new MissionControlError("Frozen Mission launch context differs", "control-pending")
    if (play.admittedAt !== null) {
      if (!isDeepStrictEqual(play.acknowledgement, validated)) throw new MissionControlError("Original Mission admission acknowledgement changed", "control-pending")
      return
    }
    await store.change(doc.id, doc.revision, current, next => {
      next.oneTime!.firstPlay!.admittedAt = Math.max(play.requestedAt, validated.admission.time.created)
      next.oneTime!.firstPlay!.acknowledgement = validated
      next.launchedCount = 1
    })
  })
}

export async function recordedMissionOneTimeAcknowledgement(access: MissionDocumentAccess, mission: MissionMap, sessionID: string, operationID: string) {
  const doc = await requireMissionOneTimeDocument(access, mission.id, mission.coordinatorSessionId)
  if (!doc) return undefined
  const play = doc.oneTime!.firstPlay
  if (sessionID !== doc.oneTime!.coordinatorSessionID || play?.operationID !== operationID || play.admittedAt === null) return undefined
  const acknowledgement = parseMissionNativeAcknowledgement(play.acknowledgement, { missionID: mission.id,
    operationID, sessionID, action: "start" })
  if (acknowledgement?.disposition !== "start-admitted") throw new MissionControlError("Original Mission admission evidence unavailable", "control-pending")
  return acknowledgement
}

export async function synchronizeMissionDocumentText(access: MissionDocumentAccess, mission: MissionMap, current: () => true) {
  await access(async store => {
    const doc = await store.read(mission.id)
    if (!doc) return
    if ("deletedAt" in doc || !doc.oneTime) throw new MissionControlError("Mission document unavailable", "invalid-input")
    if (doc.configuration.objective === mission.objective && doc.configuration.notes === mission.notes) return
    await store.change(doc.id, doc.revision, current, next => {
      next.configuration.objective = mission.objective
      if (mission.notes === undefined) delete next.configuration.notes
      else next.configuration.notes = mission.notes
      if (next.firstPlayedAt === null) next.configurationGeneration++
    })
  })
}

/** Write-ahead template lock: an uncertain task publication retains the lock. */
export async function markMissionDocumentTaskCreation(access: MissionDocumentAccess, id: string, current: () => true) {
  await access(async store => {
    const doc = await store.read(id)
    if (!doc) return
    if ("deletedAt" in doc) throw new MissionControlError("Mission document deleted", "mission-deleted")
    if (!doc.everCreatedTask) await store.change(id, doc.revision, current, next => { next.everCreatedTask = true })
  })
}

export function missionDocumentSummary(doc: MissionDocument) {
  const play = doc.oneTime?.firstPlay
  return { revision: doc.revision, configurationGeneration: doc.configurationGeneration, timeGeneration: doc.timeGeneration,
    state: doc.state, firstPlayedAt: doc.firstPlayedAt, launchedCount: doc.launchedCount, everCreatedTask: doc.everCreatedTask,
    launch: doc.configuration.launch, firstPlay: play ? { requestID: play.requestID, expectedRevision: play.expectedRevision,
      operationID: play.operationID, messageID: play.messageID, requestedAt: play.requestedAt, admittedAt: play.admittedAt,
      ...(play.inputText === undefined ? {} : { inputDigest: stableToken(play.inputText, 64) }) } : null,
    scheduleActivation: doc.scheduleActivation, ...(doc.dormantJournal ? { dormant: true as const } : {}), ...(doc.deletion ? { deletion: doc.deletion } : {}) }
}
export type MissionDocumentSummary = ReturnType<typeof missionDocumentSummary>

export async function projectMissionDocuments(access: MissionDocumentAccess, missions: MissionMap[]): Promise<void> {
  await access(async store => {
    for (const mission of missions) {
      const doc = await store.read(mission.id)
      if (!doc) continue
      if ("deletedAt" in doc || doc.oneTime && doc.oneTime.coordinatorSessionID !== mission.coordinatorSessionId
        && !(doc.preparation?.pending && doc.preparation.coordinatorSessionID === mission.coordinatorSessionId))
        throw new Error("Mission document projection binding mismatch")
      mission.document = missionDocumentSummary(doc)
    }
  })
}
