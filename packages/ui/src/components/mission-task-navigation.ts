import type { MissionMap, MissionTask } from "../../../server/src/api-types"
import { missionIncludesSession, type MissionObservedFamily } from "./mission-attention-model"

/** No generic coordinator fallback: a task link must lead to its owned worker. */
export function missionTaskConversation(mission: MissionMap, task: MissionTask, family?: MissionObservedFamily, derived?: string): string | undefined {
  const id = task.actorSessionId
  if (id && id !== mission.coordinatorSessionId && missionIncludesSession(mission.actors, id, family)) return id
  // Fallback: the coordinator's exact native delegation call for this task.
  return derived && derived !== mission.coordinatorSessionId && derived !== "global" ? derived : undefined
}
