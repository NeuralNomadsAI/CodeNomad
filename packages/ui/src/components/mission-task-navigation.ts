import type { MissionMap, MissionTask } from "../../../server/src/api-types"
import { missionIncludesSession, type MissionObservedFamily } from "./mission-attention-model"

/** No generic coordinator fallback: a task link must lead to its owned worker. */
export function missionTaskConversation(mission: MissionMap, task: MissionTask, family?: MissionObservedFamily): string | undefined {
  const id = task.actorSessionId
  return id && id !== mission.coordinatorSessionId && missionIncludesSession(mission.actors, id, family)
    ? id : undefined
}
