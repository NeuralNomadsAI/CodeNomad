import type { MissionPanelMap, MissionPanelTask } from "../../../server/src/api-types"
import { missionIncludesSession, type MissionObservedFamily } from "./mission-attention-model"

/** No generic coordinator fallback: a task link must lead to its owned worker. */
export function missionTaskConversation(mission: MissionPanelMap, task: MissionPanelTask, family?: MissionObservedFamily, derived?: string,
  actors: readonly { sessionId: string }[] = mission.actors): string | undefined {
  const id = task.actorSessionId
  if (id && id !== mission.coordinatorSessionId && missionIncludesSession(actors, id, family)) return id
  // Fallback: the coordinator's exact native delegation call for this task, never a
  // conversation the mission records as another task's owned worker.
  if (!derived || derived === mission.coordinatorSessionId || derived === "global") return undefined
  return mission.tasks.some(other => other.key !== task.key && other.actorSessionId === derived) ? undefined : derived
}
