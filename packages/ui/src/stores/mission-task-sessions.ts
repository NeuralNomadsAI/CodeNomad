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

const sameMission = (a: MissionPanelMap, b: MissionPanelMap) =>
  a.id === b.id && a.projectID === b.projectID && a.coordinatorSessionId === b.coordinatorSessionId

/** The single way to demand task sessions (see `createMissionTaskSessions` for the
 * read and fencing policy): a shown view's demand, renewed at each activity pulse
 * while `active`, and released when it hides, shows another mission or is disposed,
 * never between pulses. */
export function useMissionTaskSessionDemand(input: { instanceId: () => string; mission: () => MissionPanelMap | undefined
  active: () => boolean; pulse: () => number | undefined }): void {
  const owner = createUniqueId()
  let held: { instanceId: string; mission: MissionPanelMap } | undefined
  const release = () => { if (held) store.release(held.instanceId, held.mission, owner); held = undefined }
  createEffect(() => {
    const instanceId = input.instanceId(), mission = input.mission(), active = input.active(), pulse = input.pulse()
    if (held && (!active || !mission || held.instanceId !== instanceId || !sameMission(held.mission, mission))) release()
    if (!active || !mission) return
    held = { instanceId, mission }
    void store.demand(instanceId, mission, pulse ?? 0, owner)
  })
  onCleanup(release)
}

/** Latest exact child for a task, if native evidence proves one. */
export const missionDerivedTaskSession = store.taskSession

/** Whether a linked conversation was natively active at the latest read. */
export const missionDerivedSessionActive = store.sessionActive

export const missionDerivedSessionIncludes = store.sessionIncludes
