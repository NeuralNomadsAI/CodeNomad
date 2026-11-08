import type { MissionPanelMap } from "../../../server/src/api-types"
import { getFormQueue } from "../stores/forms"
import { getPermissionQueue } from "../stores/instances"
import type { missionStore } from "../stores/missions"
import { missionDerivedSessionIncludes } from "../stores/mission-task-sessions"
import type { MissionObservedFamily } from "./mission-attention-model"
import { currentMissionObservations, nativeMissionQuestions, type MissionQuestion, type MissionQuestionContext } from "./mission-question-owners"

type MissionKey = Pick<MissionPanelMap, "id" | "projectID" | "coordinatorSessionId">
export type MissionQuestionStore = Pick<typeof missionStore, "observations" | "observedActors" | "markObservations">

/** Open questions of the Mission's declared and observed actors and their observed
 * family, from the native queues and its current observation pages. */
export function missionQuestions(input: {
  instanceId: string; mission: MissionKey; actors: readonly { sessionId: string }[]; family?: MissionObservedFamily
  store: MissionQuestionStore
}): MissionQuestion[] {
  const { instanceId, mission, store } = input
  const pages = currentMissionObservations(store, instanceId, mission.id)
  // The coordinator always belongs to its Mission, listed among its actors or not.
  const native = nativeMissionQuestions({ actors: [{ sessionId: mission.coordinatorSessionId }, ...input.actors, ...store.observedActors(instanceId, mission.id),
    ...pages.flatMap(page => page.context.actors)], forms: getFormQueue(instanceId), permissions: getPermissionQueue(instanceId), family: input.family,
    isTaskSession: missionQuestionContext(instanceId, mission).isTaskSession })
  const observed = pages.flatMap(page => page.requests.items.map(item => ({
    sessionId: item.request.sessionID, actorSessionId: item.actorSessionId, request: { kind: item.kind, id: item.request.id } })))
  return [...new Map([...observed, ...native].map(question => [JSON.stringify([question.request.kind, question.request.id, question.sessionId]), question])).values()]
}

/** The attribution context of a Mission: its coordinator and its known native task conversations. */
export function missionQuestionContext(instanceId: string, mission: MissionKey): MissionQuestionContext {
  return { coordinatorSessionId: mission.coordinatorSessionId,
    isTaskSession: sessionId => missionDerivedSessionIncludes(instanceId, mission as MissionPanelMap, sessionId) }
}
