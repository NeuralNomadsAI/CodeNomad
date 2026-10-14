import type { MissionMap } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { instances } from "../stores/instances"
import { hydrateRestoredSessionChain } from "../stores/sessions"
import { sendMessage } from "../stores/session-actions"

export function missionAcceptsMessage(mission: MissionMap): boolean {
  return mission.status === "active" && (!mission.runState || mission.runState === "running")
    && !mission.control?.pending.length && !mission.controlUnavailable
}

/** Ordinary admission, not a workflow mutation. Caller owns the view/connection fence. */
export async function sendMissionCoordinatorMessage(input: {
  instanceId: string; mission: MissionMap; current: () => boolean
  text: (fresh: MissionMap) => string; onSending: () => void
}): Promise<{ state: "admitted"; messageId: string } | { state: "error" | "uncertain" }> {
  let attempted = false
  try {
    const { instanceId, mission: original, current } = input
    const snapshot = await serverApi.fetchMissions(instanceId)
    const fresh = snapshot.missions.find(value => value.id === original.id)
    if (!current() || !snapshot.available || !fresh || !missionAcceptsMessage(fresh)
      || fresh.coordinatorSessionId !== original.coordinatorSessionId || fresh.projectID !== original.projectID
      || !instances().get(instanceId)?.client) throw new Error("Mission changed")
    const text = input.text(fresh)
    await hydrateRestoredSessionChain(instanceId, [original.coordinatorSessionId], undefined, current)
    if (!current()) throw new Error("Mission view changed")
    attempted = true
    input.onSending()
    const messageId = await sendMessage(instanceId, original.coordinatorSessionId, text, [], {
      delivery: "steer", preserveNativeProfile: true, admissionCurrent: current,
    })
    return { state: "admitted", messageId }
  } catch { return { state: attempted ? "uncertain" : "error" } }
}
