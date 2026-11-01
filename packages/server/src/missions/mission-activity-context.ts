import type { MissionActor, MissionMap } from "./model"
import { missionActorEvidence } from "./execution-evidence"
import { missionFamilyTaskContexts, type MissionFamilyTaskContext } from "./mission-family-projection"
import { contentDigest } from "./content-digest"

export { MISSION_ACTIVITY_ACTORS } from "./mission-panel-map"
export const MISSION_MARK_MISSIONS = 16
export const MISSION_MARK_ACTORS = 10

/** Persisted display facts only; native observation is performed after the journal lock. */
export interface MissionActivityContext {
  id: string; projectID: string; revision: number; status: MissionMap["status"]; runState?: MissionMap["runState"]
  coordinatorSessionId: string
  actors: Array<Pick<MissionActor, "sessionId" | "title" | "location"> & {
    reportOwed: boolean; callOpen: boolean; taskContext?: MissionFamilyTaskContext
  }>
  actorPage: { order: string; offset: number; end: number; total: number }
  control?: Pick<NonNullable<MissionMap["control"]>, "id" | "requestID" | "expectedRevision" | "action" | "graceful" | "completedRevision"> & {
    pending: number; receipts: number; unconfirmedReceipts: number; partialDescendants: number
  }
  discardedEvents: number; controlUnavailable: boolean; notificationUnavailable: boolean; cleanupUnavailable: boolean
}

/** One linear reduction, retained by the existing hint index; briefs, reports, events,
 * full tasks and observation histories are absent from the retained context. */
export function missionActivityContext(mission: MissionMap, damage: Pick<MissionActivityContext,
  "discardedEvents" | "controlUnavailable" | "notificationUnavailable" | "cleanupUnavailable">): MissionActivityContext {
  const owed = missionActorEvidence(mission, mission.tasks), reports = new Set(owed.reportOwed), calls = new Set(owed.callOpen)
  const contexts = missionFamilyTaskContexts(mission.tasks)
  return { id: mission.id, projectID: mission.projectID, revision: mission.revision, status: mission.status,
    ...(mission.runState === undefined ? {} : { runState: mission.runState }), coordinatorSessionId: mission.coordinatorSessionId,
    actors: mission.actors.map(actor => ({ sessionId: actor.sessionId, title: actor.title, location: { ...actor.location },
      reportOwed: reports.has(actor.sessionId), callOpen: calls.has(actor.sessionId), ...(contexts[actor.sessionId] ? { taskContext: contexts[actor.sessionId] } : {}) })),
    actorPage: { order: contentDigest(JSON.stringify(mission.actors.map(actor => actor.sessionId))), offset: 0, end: mission.actors.length, total: mission.actors.length }, ...damage,
    ...(mission.control ? { control: { id: mission.control.id, requestID: mission.control.requestID, expectedRevision: mission.control.expectedRevision,
      action: mission.control.action, ...(mission.control.graceful ? { graceful: true } : {}),
      ...(mission.control.completedRevision === undefined ? {} : { completedRevision: mission.control.completedRevision }),
      pending: mission.control.pending.length, receipts: mission.control.receipts?.length ?? 0,
      unconfirmedReceipts: mission.control.receipts?.filter(receipt => receipt.acknowledgementState === "unknown").length ?? 0,
      partialDescendants: mission.control.receipts?.filter(receipt => receipt.nativeAcknowledgement?.disposition === "interrupt-observed"
        && !receipt.nativeAcknowledgement.descendants?.complete).length ?? 0 } } : {}),
  }
}

/** A bounded actor window, copied so no hint-index object escapes to native IO. */
export function activityActorWindow(context: MissionActivityContext, offset: number, limit: number): MissionActivityContext {
  const start = Math.min(offset, context.actors.length)
  return { ...context, ...(context.control ? { control: { ...context.control } } : {}),
    actors: context.actors.slice(start, start + limit).map(actor => ({ ...actor, location: { ...actor.location },
      ...(actor.taskContext ? { taskContext: { ...actor.taskContext } } : {}) })),
    actorPage: { order: context.actorPage.order, offset: start, end: Math.min(start + limit, context.actors.length), total: context.actors.length } }
}
