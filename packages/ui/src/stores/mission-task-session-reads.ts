import { createSignal } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import { parseMissionChildTaskKey, parseMissionTaskSessions } from "../lib/mission-task-sessions"
import type { OpenCodeClient } from "./opencode-client"
import { listMessageWindow } from "./session-message-pages"

// Only the latest coordinator messages are scanned: older delegations stay unlinked.
// Long real coordinators exceed 1,000 messages; read lazily, once per revision.
const COORDINATOR_MESSAGE_BOUND = 3_000
// A running subagent call records its child only on completion: while a live task
// is unlinked, the coordinator's direct children are listed (bounded) and each
// unseen child's first message is read until one has been admitted.
const CHILD_BOUND = 50

type Root = Pick<OpenCodeClient, "message" | "session">

export interface MissionTaskSessionDeps {
  /** Current connection identity; a change fences reads begun on the previous one. */
  connection(instanceId: string): unknown
  generation(instanceId: string): number
  root(instanceId: string): Root
  warn(message: string, details: Record<string, unknown>): void
}

interface Entry {
  stamp: string; pulse: number; sessions: Map<string, string[]>
  /** Direct children whose admitted first message was already examined. */
  examined: ReadonlySet<string>
  /** Linked conversations natively active at the latest read. */
  active: ReadonlySet<string>
}

const keyOf = (instanceId: string, mission: Pick<MissionMap, "id" | "coordinatorSessionId" | "projectID">) =>
  JSON.stringify([instanceId, mission.projectID, mission.id, mission.coordinatorSessionId])

function link(sessions: Map<string, string[]>, key: string, id: string): void {
  sessions.set(key, [...(sessions.get(key) ?? []).filter(value => value !== id), id])
}

const unlinked = (mission: MissionMap, sessions: Map<string, string[]>) => mission.tasks.some(task =>
  !task.actorSessionId && !sessions.has(task.key) && !["completed", "failed", "withdrawn"].includes(task.status))

export function createMissionTaskSessions(deps: MissionTaskSessionDeps) {
  const [entries, setEntries] = createSignal(new Map<string, Entry>())
  /** One read per mission at a time; a demand arriving meanwhile reruns once after it. */
  const inFlight = new Map<string, { rerun?: () => void; done: Promise<void> }>()

  /** Visible demand: a full coordinator read once per mission revision and connection
   * generation. Each activity pulse (the mission activity projection's generation)
   * rereads the native active set and, while a live task is unlinked, the
   * coordinator's direct children. A child without an admitted first message stays
   * unexamined, so a later pulse of the same revision reads it again. */
  function demand(instanceId: string, mission: MissionMap, pulse = 0): Promise<void> {
    const key = keyOf(instanceId, mission), connection = deps.connection(instanceId)
    const generation = deps.generation(instanceId)
    const stamp = `${generation}:${mission.revision}`
    const entry = entries().get(key)
    const known = entry?.stamp === stamp
    if (!connection || (known && entry.pulse === pulse)) return Promise.resolve()
    const running = inFlight.get(key)
    if (running) { running.rerun = () => void demand(instanceId, mission, pulse); return running.done }
    const flight: { rerun?: () => void; done: Promise<void> } = { done: Promise.resolve() }
    inFlight.set(key, flight)
    const root = deps.root(instanceId)
    const current = () => inFlight.get(key) === flight && deps.connection(instanceId) === connection
      && deps.generation(instanceId) === generation
    const taskKeys = new Set(mission.tasks.map(task => task.key))
    flight.done = (async () => {
      let sessions = known ? new Map(entry.sessions) : undefined
      if (!sessions) {
        const page = await listMessageWindow(root as OpenCodeClient, mission.coordinatorSessionId,
          { limit: COORDINATOR_MESSAGE_BOUND, isAuthoritative: current })
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
          const message = first.data?.[0]
          // Not admitted yet: leave unexamined for the next activity pulse.
          if (!message) continue
          examined.add(child.id)
          const task = parseMissionChildTaskKey(mission.id, message, taskKeys)
          if (task) link(sessions, task, child.id)
        }
      }
      const active = await root.session.active()
      if (!current()) return
      const linked = new Set([...sessions.values()].flat())
      const live = new Set(Object.keys(active ?? {}).filter(id => linked.has(id)))
      setEntries(previous => new Map(previous).set(key, { stamp, pulse, sessions: sessions!, examined, active: live }))
    })()
      .catch(error => deps.warn("Mission task conversations unavailable", { instanceId, missionId: mission.id, error }))
      .finally(() => {
        if (inFlight.get(key) !== flight) return
        inFlight.delete(key)
        flight.rerun?.()
      })
    return flight.done
  }

  const sessionsOf = (instanceId: string, mission: MissionMap) => entries().get(keyOf(instanceId, mission))?.sessions

  return {
    demand,
    /** Latest exact child for a task, if native evidence proves one. */
    taskSession: (instanceId: string, mission: MissionMap, taskKey: string) =>
      sessionsOf(instanceId, mission)?.get(taskKey)?.at(-1),
    /** Whether a linked conversation was natively active at the latest read. */
    sessionActive: (instanceId: string, mission: MissionMap, sessionId: string) =>
      entries().get(keyOf(instanceId, mission))?.active.has(sessionId) === true,
    sessionIncludes: (instanceId: string, mission: MissionMap, sessionId: string) => {
      const sessions = sessionsOf(instanceId, mission)
      return Boolean(sessions && [...sessions.values()].some(ids => ids.includes(sessionId)))
    },
  }
}
