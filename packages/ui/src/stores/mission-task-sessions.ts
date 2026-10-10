import type { MissionMap } from "../../../server/src/api-types"
import { getLogger } from "../lib/logger"
import { instances } from "./instances"
import { createMissionTaskSessions } from "./mission-task-session-reads"
import { getRootClient } from "./opencode-client"
import { getOpenCodeInstanceGeneration } from "./opencode-data"

const store = createMissionTaskSessions({
  connection: instanceId => instances().get(instanceId)?.client,
  generation: getOpenCodeInstanceGeneration,
  root: getRootClient,
  warn: (message, details) => getLogger("session").warn(message, details),
})

/** Visible demand; see `createMissionTaskSessions` for the read and fencing policy. */
export function demandMissionTaskSessions(instanceId: string, mission: MissionMap, pulse = 0): void {
  void store.demand(instanceId, mission, pulse)
}

/** Latest exact child for a task, if native evidence proves one. */
export const missionDerivedTaskSession = store.taskSession

/** Whether a linked conversation was natively active at the latest read. */
export const missionDerivedSessionActive = store.sessionActive

export const missionDerivedSessionIncludes = store.sessionIncludes
