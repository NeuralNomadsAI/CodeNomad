import { createSignal } from "solid-js"
import type { MissionPanelMap } from "../../../server/src/api-types"
import { parseMissionChildTaskKey, parseMissionTaskSessions } from "../../../server/src/missions/task-sessions"
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
export type MissionTaskSessionContext = Pick<MissionPanelMap, "id" | "projectID" | "coordinatorSessionId" | "revision"> & {
  tasks: readonly Pick<MissionPanelMap["tasks"][number], "key" | "status" | "actorSessionId">[]
}
type MissionSessionKey = Pick<MissionTaskSessionContext, "id" | "projectID" | "coordinatorSessionId">

export interface MissionTaskSessionDeps {
  /** Current connection identity; a change fences reads begun on the previous one. */
  connection(instanceId: string): unknown
  generation(instanceId: string): number
  root(instanceId: string): Root
  warn(message: string, details: Record<string, unknown>): void
}

interface Entry {
  generation: number; revision: number; connection: unknown; pulse: number; sessions: Map<string, string[]>
  tasks: ReadonlyMap<string, MissionTaskSessionContext["tasks"][number]>
  /** Direct children whose admitted first message was already examined. */
  examined: ReadonlySet<string>
  /** Linked conversations natively active at the latest read. */
  active: ReadonlySet<string>
}
interface Flight {
  generation: number; revision: number; connection: unknown; done: Promise<void>
  rerun?: { generation: number; connection: unknown; mission: MissionTaskSessionContext; pulse: number }
}

const keyOf = (instanceId: string, mission: MissionSessionKey) =>
  JSON.stringify([instanceId, mission.projectID, mission.id, mission.coordinatorSessionId])

function link(sessions: Map<string, string[]>, key: string, id: string): void {
  sessions.set(key, [...(sessions.get(key) ?? []).filter(value => value !== id), id])
}

const unlinked = (mission: Pick<MissionTaskSessionContext, "tasks">, sessions: Map<string, string[]>) => mission.tasks.some(task =>
  !task.actorSessionId && !sessions.has(task.key) && !["completed", "failed", "withdrawn"].includes(task.status))

export function createMissionTaskSessions(deps: MissionTaskSessionDeps) {
  const [entries, setEntries] = createSignal(new Map<string, Entry>())
  /** One read per mission at a time; a demand arriving meanwhile reruns once after it. */
  const inFlight = new Map<string, Flight>()
  /** The visible trees demanding each mission; reads continue only while one remains. */
  const owners = new Map<string, Set<string>>()

  /** Visible demand by `owner`: a full coordinator read once per mission revision and
   * connection generation. Each activity pulse (the mission activity projection's
   * generation) rereads the native active set and, while a live task is unlinked, the
   * coordinator's direct children. A child without an admitted first message stays
   * unexamined, so a later pulse of the same revision reads it again. */
  function demand(instanceId: string, mission: MissionTaskSessionContext, pulse: number, owner: string): Promise<void> {
    const key = keyOf(instanceId, mission)
    owners.set(key, (owners.get(key) ?? new Set()).add(owner))
    return run(instanceId, mission, pulse)
  }

  /** The read for the mission's current owners; a queued rerun registers none. */
  function run(instanceId: string, mission: MissionTaskSessionContext, pulse: number): Promise<void> {
    const key = keyOf(instanceId, mission), connection = deps.connection(instanceId)
    if (!owners.get(key)?.size) return Promise.resolve()
    const generation = deps.generation(instanceId)
    const entry = entries().get(key)
    const sameOwner = entry?.generation === generation && entry.connection === connection
    if (sameOwner && entry.revision > mission.revision) return Promise.resolve()
    const running = inFlight.get(key)
    if (running?.generation === generation && running.connection === connection && running.revision > mission.revision) return running.done
    const known = sameOwner && entry.revision === mission.revision
    // Owners hold different windows of the same immutable revision. Coverage may
    // grow, never shrink when a narrower selected tree follows directory demand.
    const tasks = new Map(known ? entry.tasks : [])
    for (const { key, status, actorSessionId } of mission.tasks) tasks.set(key, { key, status, ...(actorSessionId ? { actorSessionId } : {}) })
    const taskKeys = new Set(tasks.keys()), observedMission = { tasks: [...tasks.values()] }
    const sameTasks = known && entry.tasks.size === tasks.size
    if (!connection || (sameTasks && entry.pulse === pulse)) return Promise.resolve()
    // Preserve startup's no-work fast path after extracting the read logic:
    // activity invalidations must not fan out reads without a task to observe.
    if (known && !unlinked(observedMission, entry.sessions) && entry.sessions.size === 0) {
      setEntries(previous => new Map(previous).set(key, { ...entry, pulse, tasks }))
      return Promise.resolve()
    }
    if (running) {
      const queued = running.rerun
      const sameQueue = queued?.generation === generation && queued.connection === connection
      if (sameQueue && queued.mission.revision > mission.revision) return running.done
      const coverage = new Map(sameQueue && queued.mission.revision === mission.revision ? queued.mission.tasks.map(task => [task.key, task]) : [])
      for (const [key, task] of tasks) coverage.set(key, task)
      running.rerun = { generation, connection, pulse, mission: { id: mission.id, projectID: mission.projectID,
        coordinatorSessionId: mission.coordinatorSessionId, revision: mission.revision, tasks: [...coverage.values()] } }
      return running.done
    }
    const flight: Flight = {
      generation, revision: mission.revision, connection, done: Promise.resolve(),
    }
    inFlight.set(key, flight)
    const root = deps.root(instanceId)
    const current = () => inFlight.get(key) === flight && deps.connection(instanceId) === connection
      && deps.generation(instanceId) === generation && Boolean(owners.get(key)?.size)
    flight.done = (async () => {
      let sessions = known ? new Map(entry.sessions) : undefined
      if (!sessions) {
        const page = await listMessageWindow(root as OpenCodeClient, mission.coordinatorSessionId,
          { limit: COORDINATOR_MESSAGE_BOUND, isAuthoritative: current })
        if (!page || !current()) return
        // Cache exact assignment candidates once. A newly loaded directory window
        // can reveal their task keys later; only declared keys are exposed below.
        sessions = parseMissionTaskSessions(mission.id, mission.coordinatorSessionId, page.messages)
      }
      const examined = new Set(known ? entry.examined : [])
      if (unlinked(observedMission, sessions)) {
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
          const task = parseMissionChildTaskKey(mission.id, message)
          if (task) link(sessions, task, child.id)
        }
      }
      const linked = new Set([...sessions].filter(([key]) => taskKeys.has(key)).flatMap(([, ids]) => ids))
      const active = linked.size ? await root.session.active() : {}
      if (!current()) return
      const live = new Set(Object.keys(active ?? {}).filter(id => linked.has(id)))
      setEntries(previous => new Map(previous).set(key, { generation, revision: mission.revision, connection, pulse, tasks, sessions: sessions!, examined, active: live }))
    })()
      .catch(error => deps.warn("Mission task conversations unavailable", { instanceId, missionId: mission.id, error }))
      .finally(() => {
        if (inFlight.get(key) !== flight) return
        inFlight.delete(key)
        const queued = flight.rerun
        if (queued && queued.connection === deps.connection(instanceId) && queued.generation === deps.generation(instanceId))
          void run(instanceId, queued.mission, queued.pulse)
      })
    return flight.done
  }

  /** `owner` no longer shows the mission. Without another owner the read in flight
   * stops at its next step and its queued rerun is dropped. */
  function release(instanceId: string, mission: MissionSessionKey, owner: string): void {
    const key = keyOf(instanceId, mission), set = owners.get(key)
    if (!set?.delete(owner) || set.size) return
    owners.delete(key)
    const running = inFlight.get(key)
    if (running) { running.rerun = undefined; inFlight.delete(key) }
  }

  const entryOf = (instanceId: string, mission: MissionSessionKey) => {
    const entry = entries().get(keyOf(instanceId, mission))
    return entry?.generation === deps.generation(instanceId) && entry.connection === deps.connection(instanceId) ? entry : undefined
  }

  return {
    demand,
    release,
    /** Latest exact child for a task, if native evidence proves one. */
    taskSession: (instanceId: string, mission: MissionSessionKey, taskKey: string) => {
      const entry = entryOf(instanceId, mission)
      return entry?.tasks.has(taskKey) ? entry.sessions.get(taskKey)?.at(-1) : undefined
    },
    /** Whether a linked conversation was natively active at the latest read. */
    sessionActive: (instanceId: string, mission: MissionSessionKey, sessionId: string) =>
      entryOf(instanceId, mission)?.active.has(sessionId) === true,
    sessionIncludes: (instanceId: string, mission: MissionSessionKey, sessionId: string) => {
      const entry = entryOf(instanceId, mission)
      return Boolean(entry && [...entry.sessions].some(([key, ids]) => entry.tasks.has(key) && ids.includes(sessionId)))
    },
  }
}
