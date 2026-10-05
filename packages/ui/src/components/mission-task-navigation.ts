import type { MissionMap, MissionTask } from "../../../server/src/api-types"
import { missionIncludesSession, type MissionObservedFamily } from "./mission-attention-model"

/** Display navigation only: native ancestry/task context is not an actor binding.
 * When no exact owned task actor is known, explicitly open the coordinator. */
export function missionTaskConversation(mission: MissionMap, task: MissionTask, family?: MissionObservedFamily): string {
  const id = task.actorSessionId
  return id && (id === mission.coordinatorSessionId || missionIncludesSession(mission.actors, id, family))
    ? id : mission.coordinatorSessionId
}
