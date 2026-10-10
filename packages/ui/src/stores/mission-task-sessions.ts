import { createSignal } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import { getLogger } from "../lib/logger"
import { parseMissionChildTaskKey, parseMissionTaskSessions } from "../lib/mission-task-sessions"
import { instances } from "./instances"
import { getRootClient } from "./opencode-client"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { listMessageWindow } from "./session-message-pages"

// Only the latest coordinator messages are scanned: older delegations stay unlinked.
// Long real coordinators exceed 1,000 messages; read lazily, once per revision.
const COORDINATOR_MESSAGE_BOUND = 3_000
// A running subagent call records its child only on completion: while a live task
// is unlinked, the coordinator's direct children are listed (bounded) and each
// unseen child's first message is read once.
const CHILD_BOUND = 50

interface Entry {
  stamp: string; pulse: number; sessions: Map<string, string[]>
  /** Direct children whose first message was already examined. */
  examined: ReadonlySet<string>
  /** Linked conversations natively active at the latest read. */
  active: ReadonlySet<string>
}
const [entries, setEntries] = createSignal(new Map<string, Entry>())
/** One read per mission at a time; a demand arriving meanwhile reruns once after it. */
const inFlight = new Map<string, { rerun?: () => void }>()

const keyOf = (instanceId: string, mission: Pick<MissionMap, "id" | "coordinatorSessionId">) =>
  JSON.stringify([instanceId, mission.id, mission.coordinatorSessionId])

function link(sessions: Map<string, string[]>, key: string, id: string): void {
  sessions.set(key, [...(sessions.get(key) ?? []).filter(value => value !== id), id])
}

const unlinked = (mission: MissionMap, sessions: Map<string, string[]>) => mission.tasks.some(task =>
  !task.actorSessionId && !sessions.has(task.key) && !["completed", "failed", "withdrawn"].includes(task.status))

/** Visible demand: a full coordinator read once per mission revision and connection
 * generation. Each activity pulse (the mission activity projection's generation)
 * rereads the native active set and, while a live task is unlinked, the
 * coordinator's direct children. Linked children are often absent from the
 * loaded session list, so their status cannot come from it. */
export function demandMissionTaskSessions(instanceId: string, mission: MissionMap, pulse = 0): void {
  const key = keyOf(instanceId, mission), client = instances().get(instanceId)?.client
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const stamp = `${generation}:${mission.revision}`
  const entry = entries().get(key)
  const known = entry?.stamp === stamp
  if (!client || (known && entry.pulse === pulse)) return
  // No linked conversations and no live task left to discover: do not fan out
  // another native active-session read for this activity invalidation.
  if (known && !unlinked(mission, entry.sessions) && entry.sessions.size === 0) {
    setEntries(previous => new Map(previous).set(key, { ...entry, pulse }))
    return
  }
  const running = inFlight.get(key)
  if (running) { running.rerun = () => demandMissionTaskSessions(instanceId, mission, pulse); return }
  const flight: { rerun?: () => void } = {}
  inFlight.set(key, flight)
  const root = getRootClient(instanceId)
  const current = () => inFlight.get(key) === flight && instances().get(instanceId)?.client === client
    && getOpenCodeInstanceGeneration(instanceId) === generation
  const taskKeys = new Set(mission.tasks.map(task => task.key))
  void (async () => {
    let sessions = known ? new Map(entry.sessions) : undefined
    if (!sessions) {
      const page = await listMessageWindow(root, mission.coordinatorSessionId, { limit: COORDINATOR_MESSAGE_BOUND, isAuthoritative: current })
      if (!page || !current()) return
      sessions = parseMissionTaskSessions(mission.id, mission.coordinatorSessionId, page.messages, taskKeys)
    }
    const examined = new Set(known ? entry.examined : [])
    if (unlinked(mission, sessions)) {
      const children = await root.session.list({ parentID: mission.coordinatorSessionId, project: mission.projectID, limit: CHILD_BOUND })
      if (!current()) return
      for (const child of children.data ?? []) {
        if (examined.has(child.id) || [...sessions.values()].some(ids => ids.includes(child.id))) continue
        const first = await root.message.list({ sessionID: child.id, limit: 1, order: "asc" })
        if (!current()) return
        examined.add(child.id)
        const task = parseMissionChildTaskKey(mission.id, first.data?.[0], taskKeys)
        if (task) link(sessions, task, child.id)
      }
    }
    const active = await root.session.active()
    if (!current()) return
    const linked = new Set([...sessions.values()].flat())
    const live = new Set(Object.keys(active ?? {}).filter(id => linked.has(id)))
    setEntries(previous => new Map(previous).set(key, { stamp, pulse, sessions: sessions!, examined, active: live }))
  })()
    .catch(error => getLogger("session").warn("Mission task conversations unavailable", { instanceId, missionId: mission.id, error }))
    .finally(() => {
      if (inFlight.get(key) !== flight) return
      inFlight.delete(key)
      flight.rerun?.()
    })
}

/** Latest exact child for a task, if native evidence proves one. */
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
