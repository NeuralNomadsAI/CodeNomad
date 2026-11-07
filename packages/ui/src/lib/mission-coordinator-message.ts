import type { MissionMap, MissionPanelMap } from "../../../server/src/api-types"
import { backendOf } from "./backend-client"
import { captureBackendOperation } from "./backend-operation"
import { instances } from "../stores/instances"
import { hydrateRestoredSessionChain } from "../stores/sessions"
import { sendMessage } from "../stores/session-actions"

export function missionAcceptsMessage(mission: MissionPanelMap): boolean {
  return mission.status === "active" && (!mission.runState || mission.runState === "running")
    && !mission.control?.pending.length && !mission.controlUnavailable
}

/** Ordinary admission, not a workflow mutation. Caller owns the view/connection fence.
 * `text` is written from the admission read's full map. */
export async function sendMissionCoordinatorMessage(input: {
  instanceId: string; mission: MissionPanelMap; current: () => boolean
  text: (fresh: MissionMap) => string; onSending: () => void
}): Promise<{ state: "admitted"; messageId: string } | { state: "error" | "uncertain" }> {
  let attempted = false
  try {
    const { instanceId, mission: original } = input
    const operation = captureBackendOperation(instanceId, undefined, input.current)
    const current = operation.current
    if (!current()) throw new Error("Mission view changed")
    // Authoritative: the display reads' hints can miss project damage.
    const read = await backendOf(instanceId).api.fetchMissionAdmission(instanceId, original.id)
    const fresh = read.available && !read.controlUnavailable ? read.mission : undefined
    if (!current() || !fresh || !missionAcceptsMessage(fresh)
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
