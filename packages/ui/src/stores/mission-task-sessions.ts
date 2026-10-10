import { createSignal } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import { getLogger } from "../lib/logger"
import { parseMissionTaskSessions } from "../lib/mission-task-sessions"
import { instances } from "./instances"
import { getRootClient } from "./opencode-client"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { sessions } from "./session-state"
import { listMessageWindow } from "./session-message-pages"

// Only the latest coordinator messages are scanned: older delegations stay unlinked.
// Long real coordinators exceed 1,000 messages; read lazily, once per revision.
const COORDINATOR_MESSAGE_BOUND = 3_000
// Native subagent calls follow their declaration without a new revision: each new
// coordinator child rereads only this recent tail and merges it.
const TAIL_MESSAGE_BOUND = 50

interface Entry { stamp: string; children: string; sessions: Map<string, string[]> }
const [entries, setEntries] = createSignal(new Map<string, Entry>())
const pending = new Map<string, string>()

const keyOf = (instanceId: string, mission: Pick<MissionMap, "id" | "coordinatorSessionId">) =>
  JSON.stringify([instanceId, mission.id, mission.coordinatorSessionId])

function merge(previous: Map<string, string[]>, next: Map<string, string[]>): Map<string, string[]> {
  const merged = new Map(previous)
  for (const [key, ids] of next) merged.set(key, [...(merged.get(key) ?? []).filter(id => !ids.includes(id)), ...ids])
  return merged
}

/** Visible demand: a full read once per mission revision and connection generation,
 * then a tail read whenever the coordinator's known children start or appear. */
export function demandMissionTaskSessions(instanceId: string, mission: MissionMap): void {
  const key = keyOf(instanceId, mission), client = instances().get(instanceId)?.client
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const stamp = `${generation}:${mission.revision}`
  // A child exists before its call records it; it starts working only after, so
  // busy children are part of the signature too.
  const ids: string[] = []
  for (const session of sessions().get(instanceId)?.values() ?? []) {
    if (session.parentId === mission.coordinatorSessionId) ids.push(session.status === "idle" ? session.id : `${session.id}*`)
  }
  const children = ids.sort().join(",")
  const entry = entries().get(key)
  const tail = entry?.stamp === stamp
  if (!client || (tail && entry.children === children)) return
  const request = `${stamp}:${tail ? children : "full"}`
  if (pending.get(key) === request) return
  pending.set(key, request)
  const current = () => pending.get(key) === request && instances().get(instanceId)?.client === client
    && getOpenCodeInstanceGeneration(instanceId) === generation
  void listMessageWindow(getRootClient(instanceId), mission.coordinatorSessionId,
    { limit: tail ? TAIL_MESSAGE_BOUND : COORDINATOR_MESSAGE_BOUND, isAuthoritative: current })
    .then(page => {
      if (!page || !current()) return
      const taskKeys = new Set(mission.tasks.map(task => task.key))
      const found = parseMissionTaskSessions(mission.id, mission.coordinatorSessionId, page.messages, taskKeys)
      setEntries(previous => {
        const base = previous.get(key)
        return new Map(previous).set(key, { stamp, children,
          sessions: tail && base?.stamp === stamp ? merge(base.sessions, found) : found })
      })
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
