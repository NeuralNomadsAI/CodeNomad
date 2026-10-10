import { createSignal } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import { getLogger } from "../lib/logger"
import { parseMissionTaskSessions } from "../lib/mission-task-sessions"
import { instances } from "./instances"
import { getRootClient } from "./opencode-client"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { listMessageWindow } from "./session-message-pages"

// Only the latest coordinator messages are scanned: older delegations stay unlinked.
// Long real coordinators exceed 1,000 messages; read lazily, once per revision.
const COORDINATOR_MESSAGE_BOUND = 3_000

interface Entry { stamp: string; sessions: Map<string, string[]> }
const [entries, setEntries] = createSignal(new Map<string, Entry>())
const pending = new Map<string, string>()

const keyOf = (instanceId: string, mission: Pick<MissionMap, "id" | "coordinatorSessionId">) =>
  JSON.stringify([instanceId, mission.id, mission.coordinatorSessionId])

/** Visible demand: read once per mission revision and connection generation. */
export function demandMissionTaskSessions(instanceId: string, mission: MissionMap): void {
  const key = keyOf(instanceId, mission), client = instances().get(instanceId)?.client
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const stamp = `${generation}:${mission.revision}`
  if (!client || entries().get(key)?.stamp === stamp || pending.get(key) === stamp) return
  pending.set(key, stamp)
  const current = () => pending.get(key) === stamp && instances().get(instanceId)?.client === client
    && getOpenCodeInstanceGeneration(instanceId) === generation
  void listMessageWindow(getRootClient(instanceId), mission.coordinatorSessionId, { limit: COORDINATOR_MESSAGE_BOUND, isAuthoritative: current })
    .then(page => {
      if (!page || !current()) return
      const taskKeys = new Set(mission.tasks.map(task => task.key))
      const sessions = parseMissionTaskSessions(mission.id, mission.coordinatorSessionId, page.messages, taskKeys)
      setEntries(previous => new Map(previous).set(key, { stamp, sessions }))
    })
    .catch(error => getLogger("session").warn("Mission task conversations unavailable", { instanceId, missionId: mission.id, error }))
    .finally(() => { if (pending.get(key) === stamp) pending.delete(key) })
}

/** Latest exact child for a task, if the coordinator's native call proves one. */
export function missionDerivedTaskSession(instanceId: string, mission: MissionMap, taskKey: string): string | undefined {
  return entries().get(keyOf(instanceId, mission))?.sessions.get(taskKey)?.at(-1)
}

export function missionDerivedSessionIncludes(instanceId: string, mission: MissionMap, sessionId: string): boolean {
  const sessions = entries().get(keyOf(instanceId, mission))?.sessions
  return Boolean(sessions && [...sessions.values()].some(ids => ids.includes(sessionId)))
}
