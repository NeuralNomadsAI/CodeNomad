import type { MissionPanelMap } from "../../../server/src/api-types"
import { getFormQueue } from "../stores/forms"
import { getPermissionQueue } from "../stores/instances"
import type { missionStore } from "../stores/missions"
import { missionDerivedSessionIncludes } from "../stores/mission-task-sessions"
import { selectMissionAttention, type MissionObservedFamily } from "./mission-attention-model"
import type { MissionQuestion, MissionQuestionContext } from "./mission-question-owners"

type MissionKey = Pick<MissionPanelMap, "id" | "projectID" | "coordinatorSessionId">

/** Open questions of the Mission's declared and observed actors and their observed
 * family, from the native queues and the panel's off-page request windows. */
export function missionQuestions(input: {
  instanceId: string; mission: MissionKey; actors: readonly { sessionId: string }[]; family?: MissionObservedFamily
  store: Pick<typeof missionStore, "observations" | "observedActors">
}): MissionQuestion[] {
  const { instanceId, mission, store } = input
  // The coordinator always belongs to its Mission, listed among its actors or not.
  const native = selectMissionAttention({ actors: [{ sessionId: mission.coordinatorSessionId }, ...input.actors, ...store.observedActors(instanceId, mission.id)],
    forms: getFormQueue(instanceId), permissions: getPermissionQueue(instanceId), tasks: [], family: input.family })
    .flatMap(item => item.open && item.sessionId && item.kind !== "blocked"
      ? [{ sessionId: item.sessionId, actorSessionId: item.actorSessionId, request: { kind: item.kind, id: item.id.slice(item.kind.length + 1) } }] : [])
  const observed = store.observations(instanceId, mission.id).flatMap(page => page.requests.state === "unknown" ? [] : page.requests.items.map(item => ({
    sessionId: item.request.sessionID, actorSessionId: item.actorSessionId, request: { kind: item.kind, id: item.request.id } })))
  return [...new Map([...observed, ...native].map(question => [JSON.stringify([question.request.kind, question.request.id, question.sessionId]), question])).values()]
}

/** The attribution context of a Mission: its coordinator and its known native task conversations. */
export function missionQuestionContext(instanceId: string, mission: MissionKey): MissionQuestionContext {
  return { coordinatorSessionId: mission.coordinatorSessionId,
    isTaskSession: sessionId => missionDerivedSessionIncludes(instanceId, mission as MissionPanelMap, sessionId) }
}
