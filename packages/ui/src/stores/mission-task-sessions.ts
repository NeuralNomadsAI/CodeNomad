import { createEffect, createUniqueId, onCleanup } from "solid-js"
import type { MissionPanelMap } from "../../../server/src/api-types"
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

/** Visible demand by `owner`; see `createMissionTaskSessions` for the read and fencing policy. */
export function demandMissionTaskSessions(instanceId: string, mission: MissionPanelMap, pulse = 0, owner?: string): void {
  void store.demand(instanceId, mission, pulse, owner)
}

/** `owner` stopped showing the mission; reads stop once no owner remains. */
export function releaseMissionTaskSessions(instanceId: string, mission: MissionPanelMap, owner?: string): void {
  store.release(instanceId, mission, owner)
}

/** A shown task tree's demand: renewed at each activity pulse while `active`, and
 * released when it hides, shows another mission or is disposed, never between pulses. */
export function useMissionTaskSessionDemand(input: { instanceId: () => string; mission: () => MissionPanelMap | undefined
  active: () => boolean; pulse: () => number | undefined }): void {
  const owner = createUniqueId()
  let held: { instanceId: string; mission: MissionPanelMap } | undefined
  const release = () => { if (held) releaseMissionTaskSessions(held.instanceId, held.mission, owner); held = undefined }
  createEffect(() => {
    const instanceId = input.instanceId(), mission = input.mission(), active = input.active(), pulse = input.pulse()
    if (held && (!active || !mission || held.instanceId !== instanceId || held.mission.id !== mission.id)) release()
    if (!active || !mission) return
    held = { instanceId, mission }
    demandMissionTaskSessions(instanceId, mission, pulse, owner)
  })
  onCleanup(release)
}

/** Latest exact child for a task, if native evidence proves one. */
export const missionDerivedTaskSession = store.taskSession

/** Whether a linked conversation was natively active at the latest read. */
export const missionDerivedSessionActive = store.sessionActive

export const missionDerivedSessionIncludes = store.sessionIncludes
