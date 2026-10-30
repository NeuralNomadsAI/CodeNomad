import { isDeepStrictEqual } from "node:util"
import { canonicalAuthority } from "./authority-protocol"
import { MissionControlError } from "./control-error"
import type { MissionSessionAdapter, NativeMissionSession } from "./control-types"
import { matchesExecution } from "./execution"
import type { MissionJournal } from "./journal"
import { missionConfigurationSchema, requiresMissionCalendar, type MissionConfiguration } from "./launch-policy"
import type { NativeMissionDocumentStore } from "./mission-document-store"
import type { MissionDocument } from "./mission-document"
import { missionDocumentChanges } from "./mission-document-state"
import { MISSION_SCHEMA_VERSION, type MissionPreparedEvent } from "./model"
import { missionCoordinatorTitle } from "./mission-title"
import { freezeCompareProfiles, validateMissionProfiles } from "./playbook-profiles"
import { stableToken } from "./receipt-identity"
import { missionCoordinatorSessionID, isMissionCoordinatorSession } from "./session-identity"
import { sameLocation } from "../opencode/compatibility/location"

export interface MissionPreparationNative {
  read(sessionID: string): Promise<NativeMissionSession | undefined>
  /** Positive empty-message/inbox/family/claim proof, rechecked at publication. */
  empty(session: NativeMissionSession): Promise<() => true>
}
export type MissionPreparationRequest = { missionID: string; requestID: string; expectedRevision: number; configuration: MissionConfiguration }

/** Called under the ordinary project writer, then document exclusion, in that order.
 * An original intent survives every native/journal/document acknowledgement seam. */
export async function configureMissionPreparation(journal: MissionJournal, store: NativeMissionDocumentStore,
  sessions: MissionSessionAdapter, native: MissionPreparationNative, input: MissionPreparationRequest, current: () => true, now: number,
  admitted?: (document: MissionDocument) => void) {
  return store.withExclusion(async locked => {
    const read = await locked.read(input.missionID)
    if (!read || "deletedAt" in read || !read.oneTime) throw new Error("Mission preparation unavailable")
    let doc: MissionDocument = read
    const configuration = missionConfigurationSchema.parse(input.configuration)
    const fingerprint = stableToken(canonicalAuthority({ action: "configure", configuration, deleteManagedSessions: false }), 64)
    const previous = doc.preparation
    if (previous?.requestID === input.requestID) {
      if (previous.expectedRevision !== input.expectedRevision || previous.fingerprint !== fingerprint) throw new MissionControlError("Preparation request conflict", "request-conflict")
      if (!previous.pending) return doc
    } else {
      if (previous?.pending) throw new MissionControlError("Original Mission preparation is unresolved", "control-pending")
      if (doc.revision !== input.expectedRevision) throw new MissionControlError("Mission preparation revision conflict", "revision-conflict")
    }
    if (!isDeepStrictEqual(configuration.roots, doc.configuration.roots)) throw new Error("Mission preparation scope locked")
    validateMissionProfiles(configuration.template, configuration.profiles)
    const profiles = freezeCompareProfiles(configuration.template, configuration.profiles)
    if (profiles === undefined) delete configuration.profiles
    else configuration.profiles = profiles
    const snapshot = await journal.snapshot(), mission = snapshot.missions.find(item => item.id === doc.id)
    if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.cleanupUnavailable
      || !mission || mission.status !== "active" || mission.runState !== "prepared" || mission.control || mission.tasks.length
      || doc.firstPlayedAt !== null || doc.state !== "paused" || doc.everCreatedTask || doc.deletion || doc.scheduleActivation && doc.scheduleActivation.state !== "ready"
      || doc.calendarOwner || doc.synchronization || doc.blocked) throw new Error("Mission preparation locked")
    const change = async (update: Parameters<typeof locked.change>[3], fence = current) => {
      doc = await locked.change(doc!.id, doc!.revision, fence, update)
    }
    const originalID = previous?.pending ? previous.previousSessionID : doc.oneTime!.coordinatorSessionID
    const original = await native.read(originalID)
    const marker = original?.metadata?.["codenomad.mission"] as { version?: unknown; missionID?: unknown; kind?: unknown } | undefined
    if (!original || !isMissionCoordinatorSession(original.id, doc.id) || original.parentID || original.projectID !== doc.projectID || !sameLocation(original.location, doc.oneTime!.location)
      || marker?.version !== 1 || marker.missionID !== doc.id || marker.kind !== "coordinator") throw new Error("Prepared coordinator ownership unavailable")
    const originalEmpty = await native.empty(original)
    if (!previous?.pending) {
      // The preparation entry and its replacement coordinator's two lifecycle slots.
      await journal.assertCanAppend(doc.id, 3)
      if (mission.coordinatorSessionId !== originalID) throw new Error("Prepared coordinator binding differs")
      const createdAt = Math.max(now, mission.updatedAt + 1)
      await change(value => { value.preparation = { requestID: input.requestID, expectedRevision: input.expectedRevision,
        expectedJournalRevision: mission.revision, fingerprint, configuration, createdAt, previousSessionID: originalID,
        coordinatorSessionID: missionCoordinatorSessionID(doc!.id, createdAt),
        attempted: false, pending: true } }, () => { originalEmpty(); return current() })
    }
    admitted?.(doc)
    const intent = doc!.preparation!
    const title = missionCoordinatorTitle(intent.configuration.title, intent.configuration.objective)
    const event: MissionPreparedEvent = { version: MISSION_SCHEMA_VERSION, type: "mission.prepared",
      id: `evt_${stableToken(`${doc!.id}\0prepared-${intent.requestID}`, 28)}`, missionID: doc!.id, projectID: doc!.projectID,
      projectCanonical: doc!.projectCanonical, requestID: intent.requestID, fingerprint: intent.fingerprint,
      expectedRevision: intent.expectedJournalRevision, createdAt: intent.createdAt,
      title: intent.configuration.title, objective: intent.configuration.objective, notes: intent.configuration.notes,
      template: intent.configuration.template, taskMode: intent.configuration.taskMode, profiles: intent.configuration.profiles,
      coordinator: { sessionID: intent.coordinatorSessionID, title, location: original.location } }
    const saved = await journal.event(doc!.id, event.id)
    if (!saved) await journal.assertCanAppend(event)
    let coordinator = await native.read(intent.coordinatorSessionID)
    if (!coordinator) {
      if (intent.attempted) throw new Error("Prepared coordinator creation remains unconfirmed")
      await change(value => { value.preparation!.attempted = true }, () => { originalEmpty(); return current() })
      originalEmpty(); current()
      coordinator = await sessions.create({ id: intent.coordinatorSessionID, title, location: { ...original.location },
        metadata: structuredClone(original.metadata!), ...intent.configuration.profiles?.coordinator })
    }
    if (coordinator.id !== intent.coordinatorSessionID || coordinator.parentID || coordinator.projectID !== doc!.projectID
      || !sameLocation(coordinator.location, original.location) || coordinator.title !== title
      || !isDeepStrictEqual(coordinator.metadata, original.metadata) || !matchesExecution(intent.configuration.profiles?.coordinator, coordinator))
      throw new Error("Prepared replacement coordinator differs")
    const replacementEmpty = await native.empty(coordinator)
    const fence = (): true => { originalEmpty(); replacementEmpty(); return current() }
    if (saved) {
      if (canonicalAuthority(JSON.parse(JSON.stringify(saved))) !== canonicalAuthority(JSON.parse(JSON.stringify(event)))) throw new Error("Mission preparation journal differs")
    } else {
      if (mission.revision !== intent.expectedJournalRevision) throw new Error("Mission preparation journal revision conflict")
      await journal.assertCanAppend(event)
      fence()
      await journal.append(event, fence)
    }
    const published = (await journal.snapshot()).missions.find(item => item.id === doc!.id)
    if (!published || published.revision !== intent.expectedJournalRevision + 1 || published.coordinatorSessionId !== coordinator.id)
      throw new Error("Mission preparation journal publication unconfirmed")
    await change(value => {
      value.preparation!.pending = false
      missionDocumentChanges.configure(value, intent.configuration, intent.createdAt)
      value.oneTime!.coordinatorSessionID = coordinator!.id
      value.dormantJournal = requiresMissionCalendar(intent.configuration.launch)
        ? { revision: intent.expectedJournalRevision + 1, deleted: false } : null
      if (!value.dormantJournal) value.scheduleActivation = null
    }, fence)
    return doc!
  }, { wait: false })
}
