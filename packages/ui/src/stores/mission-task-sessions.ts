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
// Native subagent calls follow their declaration without a new revision: while a
// live task is still unlinked, each activity pulse rereads only this recent tail.
const TAIL_MESSAGE_BOUND = 50

interface Entry {
  stamp: string; pulse: number; sessions: Map<string, string[]>
  /** Linked conversations natively active at the latest read. */
  active: ReadonlySet<string>
}
const [entries, setEntries] = createSignal(new Map<string, Entry>())
const pending = new Map<string, string>()

const keyOf = (instanceId: string, mission: Pick<MissionMap, "id" | "coordinatorSessionId">) =>
  JSON.stringify([instanceId, mission.id, mission.coordinatorSessionId])

function merge(previous: Map<string, string[]>, next: Map<string, string[]>): Map<string, string[]> {
  const merged = new Map(previous)
  for (const [key, ids] of next) merged.set(key, [...(merged.get(key) ?? []).filter(id => !ids.includes(id)), ...ids])
  return merged
}

const live = (mission: MissionMap, sessions: Map<string, string[]>) => mission.tasks.some(task =>
  !task.actorSessionId && !sessions.has(task.key) && !["completed", "failed", "withdrawn"].includes(task.status))

/** Visible demand: a full read once per mission revision and connection generation.
 * Each activity pulse (the mission activity projection's generation) rereads the
 * native active set, plus the coordinator tail while a live task is unlinked.
 * Linked children are often absent from the loaded session list, so their status
 * cannot come from it. */
export function demandMissionTaskSessions(instanceId: string, mission: MissionMap, pulse = 0): void {
  const key = keyOf(instanceId, mission), client = instances().get(instanceId)?.client
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const stamp = `${generation}:${mission.revision}`
  const entry = entries().get(key)
  const known = entry?.stamp === stamp
  if (!client || (known && entry.pulse === pulse)) return
  const tail = known && live(mission, entry.sessions)
  // Nothing linked and nothing left to discover: the pulse needs no native read
  // (the active map fans out per active session on the server).
  if (known && !tail && entry.sessions.size === 0) {
    setEntries(previous => new Map(previous).set(key, { ...entry, pulse }))
    return
  }
  const request = `${stamp}:${known ? pulse : "full"}`
  if (pending.get(key) === request) return
  pending.set(key, request)
  const root = getRootClient(instanceId)
  const current = () => pending.get(key) === request && instances().get(instanceId)?.client === client
    && getOpenCodeInstanceGeneration(instanceId) === generation
  const page = known && !tail ? Promise.resolve(undefined)
    : listMessageWindow(root, mission.coordinatorSessionId, { limit: tail ? TAIL_MESSAGE_BOUND : COORDINATOR_MESSAGE_BOUND, isAuthoritative: current })
  void Promise.all([page, root.session.active()])
    .then(([page, active]) => {
      if (!current() || (!known && !page)) return
      const taskKeys = new Set(mission.tasks.map(task => task.key))
      const found = page ? parseMissionTaskSessions(mission.id, mission.coordinatorSessionId, page.messages, taskKeys) : new Map()
      setEntries(previous => {
        const base = previous.get(key)
        const sessions = known && base?.stamp === stamp ? merge(base.sessions, found) : found
        const linked = new Set([...sessions.values()].flat())
        const running = new Set(Object.keys(active ?? {}).filter(id => linked.has(id)))
        return new Map(previous).set(key, { stamp, pulse, sessions, active: running })
      })
    })
    .catch(error => getLogger("session").warn("Mission task conversations unavailable", { instanceId, missionId: mission.id, error }))
    .finally(() => { if (pending.get(key) === request) pending.delete(key) })
}

/** Latest exact child for a task, if the coordinator's native call proves one. */
export function missionDerivedTaskSession(instanceId: string, mission: MissionMap, taskKey: string): string | undefined {
  return entries().get(keyOf(instanceId, mission))?.sessions.get(taskKey)?.at(-1)
}

/** Whether a linked conversation was natively active at the latest read. */
export function missionDerivedSessionActive(instanceId: string, mission: MissionMap, sessionId: string): boolean {
  return entries().get(keyOf(instanceId, mission))?.active.has(sessionId) === true
}

export function missionDerivedSessionIncludes(instanceId: string, mission: MissionMap, sessionId: string): boolean {
  const sessions = entries().get(keyOf(instanceId, mission))?.sessions
  return Boolean(sessions && [...sessions.values()].some(ids => ids.includes(sessionId)))
}
