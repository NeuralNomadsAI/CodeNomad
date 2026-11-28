import { createSignal, untrack } from "solid-js"
import type { MissionPanelMap } from "../../../server/src/api-types"
import { parseMissionChildTaskKey, parseMissionTaskSessions } from "../../../server/src/missions/task-sessions"
import type { OpenCodeClient } from "./opencode-client"

// Coordinator messages are scanned newest-first in pages, stopping as soon as every
// task without a recorded actor is linked. The scan keeps its place: a wider task
// window resumes it, and a later revision reads only the messages added since.
// Long real coordinators exceed 1,000 messages; older delegations stay unlinked.
const COORDINATOR_PAGE_SIZE = 100
const COORDINATOR_MESSAGE_BOUND = 3_000
// A running subagent call records its child only on completion: while a live task
// is unlinked, the coordinator's direct children are listed (bounded) and each
// unseen child's first message is read in bounded parallel batches.
const CHILD_BOUND = 50
const CHILD_CONCURRENCY = 6

type Root = Pick<OpenCodeClient, "message" | "session">
export type MissionTaskSessionContext = Pick<MissionPanelMap, "id" | "projectID" | "coordinatorSessionId" | "revision"> & {
  tasks: readonly Pick<MissionPanelMap["tasks"][number], "key" | "status" | "actorSessionId">[]
}
type MissionSessionKey = Pick<MissionTaskSessionContext, "id" | "projectID" | "coordinatorSessionId">

export interface MissionTaskSessionDeps {
  /** Current connection identity; a change fences reads begun on the previous one. */
  connection(instanceId: string): unknown
  generation(instanceId: string): number
  signal?(instanceId: string): AbortSignal
  root(instanceId: string): Root
  warn(message: string, details: Record<string, unknown>): void
}

/** Where the coordinator scan stands: the newest message it read, the cursor of the
 * older messages it has not read (absent once none remain) and how many it read. */
interface Scan { newest?: string; older?: string; read: number }
interface Entry {
  signal?: AbortSignal
  generation: number; revision: number; connection: unknown; pulse: number; sessions: Map<string, string[]>
  scan: Scan
  tasks: ReadonlyMap<string, MissionTaskSessionContext["tasks"][number]>
  /** Direct children whose admitted first message was already examined. */
  examined: ReadonlySet<string>
  /** Linked conversations natively active at the latest read. */
  active: ReadonlySet<string>
}
interface Flight {
  signal?: AbortSignal
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
    const signal = deps.signal?.(instanceId)
    if (signal?.aborted) return Promise.resolve()
    const key = keyOf(instanceId, mission), connection = deps.connection(instanceId)
    if (!owners.get(key)?.size) return Promise.resolve()
    const generation = deps.generation(instanceId)
    // A demand is an action: the effect making it must not subscribe to the entries it
    // writes below, or two views at different pulses rerun each other without end.
    const entry = untrack(entries).get(key)
    const sameOwner = entry?.generation === generation && entry.connection === connection && entry.signal === signal
    if (sameOwner && entry.revision > mission.revision) return Promise.resolve()
    const candidate = inFlight.get(key)
    const running = candidate?.generation === generation && candidate.connection === connection && candidate.signal === signal ? candidate : undefined
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
    // A wider task window with an unlinked task resumes the coordinator scan where it stopped.
    const resumes = known && Boolean(entry.scan.older) && entry.scan.read < COORDINATOR_MESSAGE_BOUND
      && observedMission.tasks.some(task => !task.actorSessionId && !entry.sessions.has(task.key))
    if (known && !resumes && !unlinked(observedMission, entry.sessions) && entry.sessions.size === 0) {
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
      generation, revision: mission.revision, connection, signal, done: Promise.resolve(),
    }
    inFlight.set(key, flight)
    const root = deps.root(instanceId)
    const current = () => !signal?.aborted && inFlight.get(key) === flight && deps.connection(instanceId) === connection
      && deps.generation(instanceId) === generation && Boolean(owners.get(key)?.size)
    flight.done = (async () => {
      // An earlier revision's links stay true: only the messages added since are read.
      const seed = sameOwner ? entry : undefined
      const sessions = new Map(seed?.sessions)
      let scan: Scan = seed ? seed.scan : { read: 0 }
      const page = async (cursor?: string) => {
        const response = await root.message.list(cursor
          ? { sessionID: mission.coordinatorSessionId, limit: COORDINATOR_PAGE_SIZE, cursor }
          : { sessionID: mission.coordinatorSessionId, limit: COORDINATOR_PAGE_SIZE, order: "desc" }, { signal })
        const batch = response.data ?? [], older = response.cursor?.next ?? undefined
        // An empty page or a cursor that does not advance ends the transcript.
        return { batch, older: batch.length && older !== cursor ? older : undefined }
      }
      // A newest-first page's children per task, oldest first.
      const links = (batch: readonly unknown[]) => parseMissionTaskSessions(mission.id, mission.coordinatorSessionId, [...batch].reverse())
      // Places found children before or after those already kept for their task.
      const keep = (target: Map<string, string[]>, found: Map<string, string[]>, position: "older" | "newer") => {
        for (const [taskKey, ids] of found) {
          const kept = target.get(taskKey) ?? []
          target.set(taskKey, position === "older" ? [...ids.filter(id => !kept.includes(id)), ...kept] : [...kept.filter(id => !ids.includes(id)), ...ids])
        }
      }
      const messageID = (message: unknown) => (message as { id?: string } | undefined)?.id
      // Both readers answer whether the read is still current.
      // From the newest message down to `boundary`, the newest one an earlier revision read
      // (one page without it). That page is read whole, so a call still running then is seen completed.
      const head = async (boundary: string | undefined) => {
        const found = new Map<string, string[]>()
        let cursor: string | undefined, newest: string | undefined, read = 0, reached = false
        do {
          const next = await page(cursor)
          if (!current()) return false
          newest ??= messageID(next.batch[0])
          keep(found, links(next.batch), "older")
          read += next.batch.length
          reached = boundary !== undefined && next.batch.some(message => messageID(message) === boundary)
          cursor = next.older
        } while (boundary !== undefined && !reached && cursor && read < COORDINATOR_MESSAGE_BOUND)
        keep(sessions, found, "newer")
        scan = reached ? { newest: newest ?? boundary, older: scan.older, read: scan.read + read } : { newest, older: cursor, read }
        return true
      }
      // Older messages not read yet: continue while a task of this window is unlinked.
      const rest = async () => {
        while (scan.older && scan.read < COORDINATOR_MESSAGE_BOUND
          && observedMission.tasks.some(task => !task.actorSessionId && !sessions.has(task.key))) {
          const next = await page(scan.older)
          if (!current()) return false
          keep(sessions, links(next.batch), "older")
          scan = { newest: scan.newest, older: next.older, read: scan.read + next.batch.length }
        }
        return true
      }
      if (!known && !await head(seed?.scan.newest)) return
      try { if (!await rest()) return } catch (error) {
        // A cursor kept from an earlier read may no longer read: scan again from the newest message.
        if (!current() || !seed?.scan.older || scan.older !== seed.scan.older) throw error
        if (!await head(undefined) || !await rest()) return
      }
      const examined = new Set(known ? entry.examined : [])
      if (unlinked(observedMission, sessions)) {
        const children = await root.session.list({ parentID: mission.coordinatorSessionId, project: mission.projectID, limit: CHILD_BOUND }, { signal })
        if (!current()) return
        const pending = (children.data ?? []).filter(child => !examined.has(child.id) && ![...sessions.values()].some(ids => ids.includes(child.id)))
        let index = 0
        await Promise.all(Array.from({ length: Math.min(CHILD_CONCURRENCY, pending.length) }, async () => {
          while (index < pending.length) {
            const child = pending[index++]
            if (!current()) return
            const first = await root.message.list({ sessionID: child.id, limit: 1, order: "asc" }, { signal })
            if (!current()) return
            const message = first.data?.[0]
            // Not admitted yet: leave unexamined for the next activity pulse.
            if (!message) continue
            examined.add(child.id)
            const task = parseMissionChildTaskKey(mission.id, message)
            if (task) link(sessions, task, child.id)
          }
        }))
      }
      const linked = new Set([...sessions].filter(([key]) => taskKeys.has(key)).flatMap(([, ids]) => ids))
      const active = linked.size ? await root.session.active({ signal }) : {}
      if (!current()) return
      const live = new Set(Object.keys(active ?? {}).filter(id => linked.has(id)))
      setEntries(previous => new Map(previous).set(key, { generation, revision: mission.revision, connection, signal, pulse, tasks, sessions, scan, examined, active: live }))
    })()
      .catch(error => { if (current()) deps.warn("Mission task conversations unavailable", { instanceId, missionId: mission.id, error }) })
      .finally(() => {
        if (inFlight.get(key) !== flight) return
        const follow = current()
        inFlight.delete(key)
        const queued = flight.rerun
        if (follow && queued && queued.connection === deps.connection(instanceId) && queued.generation === deps.generation(instanceId))
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
    return entry?.generation === deps.generation(instanceId) && entry.connection === deps.connection(instanceId) && entry.signal === deps.signal?.(instanceId) && !entry.signal?.aborted ? entry : undefined
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
