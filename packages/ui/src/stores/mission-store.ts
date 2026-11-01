import { createSignal, untrack } from "solid-js"

import type { MissionActivityProjection, MissionListResponse, MissionPanelMap, MissionSummary } from "../../../server/src/api-types"
import type { MissionCleanup, MissionUnavailableReason } from "../../../server/src/missions/model"
import { MISSION_LIST_MAX_INCLUDE, missionSummary } from "../../../server/src/missions/mission-summary"
import { MISSION_TASK_PAGE, type MissionTaskPageResponse, type MissionTaskRequest } from "../../../server/src/missions/mission-panel-map"
import { MissionTaskPageReadError, type MissionTaskPageFailure } from "../lib/mission-task-page-read"
import { assertTaskReadLive, raceTaskRead, TASK_READ_TIMEOUT_MS } from "../lib/mission-task-read-lifetime"
import type { MissionTaskPageContext } from "../lib/mission-task-page-schema"
import { answerTaskRequest, coverAttention, createTaskPageCache, failTaskRequest, mergeTaskPages, recordTaskRequest, reorderTaskPageCache, taskRequestsOf,
  type MissionTaskPageCache } from "./mission-task-pages"

export type MissionLoadStatus = "idle" | "loading" | "ready" | "unavailable" | "error"

export interface MissionViewState {
  status: MissionLoadStatus
  projectID?: string
  /** Compact maps (`compactMissionMap`): the open and wanted missions, or every one of a list without summaries. */
  missions: MissionPanelMap[]
  /** One row per mission, in display order. */
  summaries: MissionSummary[]
  /** Set while the backend lists summaries; the next read sends it back to skip unchanged rows. */
  summariesVersion?: string
  reason?: MissionUnavailableReason
  error?: string
  generatedAt?: number
  discardedEvents?: number
  activity?: MissionActivityProjection
  cleanups?: MissionCleanup[]
  cleanupUnavailable?: boolean
  /** Reads further into a map's tasks (`loadTasks`) running, or failed and not answered since (with the read to try again), by mission. */
  taskReads?: Record<string, MissionTaskRead>
  /** By mission, the attention windows (`MissionTaskAttention`) answered for its newest sequence. */
  taskAttention?: Record<string, MissionTaskAttentionRead>
}

export interface MissionListRequest { include?: string[]; summariesVersion?: string }
/** `failure`: the oldest read further that failed and no read has answered since; others succeeding keep it. */
export interface MissionTaskRead { loading: boolean; failure?: { error: string; request: MissionTaskRequest; reason?: MissionTaskPageFailure } }
/** The attention windows answered for `sequence`, by offset. */
export interface MissionTaskAttentionRead { sequence: string; windows: number[] }
/** How a read further ended: answered in the shown order, failed, refused or answered in
 * another order (the list is read again, and the read with it), or not sent (no paged map). */
export type MissionTaskReadResult = "read" | "failed" | "reordered" | "skipped"
export type MissionTaskFetch = (instanceId: string, missionId: string, request: MissionTaskRequest,
  scope: { projectID: string; current(): boolean; signal: AbortSignal; deadline: number; context?: MissionTaskPageContext }) => Promise<MissionTaskPageResponse>

const EMPTY_STATE: MissionViewState = { status: "idle", missions: [], summaries: [] }

export interface MissionStore {
  state(instanceId: string): MissionViewState
  trackedInstanceIds(): string[]
  demandedInstanceIds(): string[]
  setDemand(instanceId: string, demanded: boolean): void
  /** `owner` needs this map; undefined releases it. A central taskReader also owns
   * read-only refresh demand when the panel is unmounted. */
  want(instanceId: string, owner: string, missionId: string | undefined, taskReader?: boolean): void
  ensure(instanceId: string): Promise<void>
  refresh(instanceId: string): Promise<void>
  /** Reads more of a listed paged map's tasks, a window or tasks by name, into that map. */
  loadTasks(instanceId: string, missionId: string, request: MissionTaskRequest): Promise<MissionTaskReadResult>
  /** Fence in-flight task slices on a connection/plugin transition, retaining last-good rows. */
  invalidateTasks(instanceId: string): void
  clear(instanceId: string): void
}

export function createMissionStore(fetchMissions: (instanceId: string, request: MissionListRequest) => Promise<MissionListResponse>,
  fetchTasks?: MissionTaskFetch): MissionStore {
  const [states, setStates] = createSignal(new Map<string, MissionViewState>())
  const generations = new Map<string, number>()
  const demand = new Set<string>()
  const inFlight = new Map<string, Promise<void>>()
  const trailing = new Set<string>()
  const wants = new Map<string, Map<string, string>>()
  const readerDemand = new Map<string, Set<string>>()
  const ownerLifetimes = new Map<string, Map<string, { generation: number; active: boolean; controller: AbortController }>>()
  let ownershipGeneration = 0
  const acquireOwner = (instanceId: string, missionId: string) => {
    let lifetimes = ownerLifetimes.get(instanceId)
    if (!lifetimes) ownerLifetimes.set(instanceId, lifetimes = new Map())
    let lifetime = lifetimes.get(missionId)
    if (!lifetime?.active) lifetimes.set(missionId, lifetime = { generation: ++ownershipGeneration, active: true, controller: new AbortController() })
    return lifetime
  }
  /** The includes of each instance's read in flight. */
  const requested = new Map<string, readonly string[]>()
  /** Deactivations per instance: a read's own follow-up survives only if none happened while it ran. */
  const cancellations = new Map<string, number>()
  /** Rows read further, per instance and mission, and the chain of each mission's page reads. */
  const pages = new Map<string, Map<string, MissionTaskPageCache>>()
  const pageReads = new Map<string, Promise<MissionTaskReadResult>>(), queuedReads = new Map<string, Promise<MissionTaskReadResult>>()
  /** The list reads' own maps, per instance and mission: every page merges against them. */
  const bases = new Map<string, Map<string, MissionPanelMap>>()
  /** Bumped by `clear`: a page read of an earlier epoch never publishes. */
  const epochs = new Map<string, number>()
  const taskLifetimes = new Map<string, AbortController>()
  const withPages = (instanceId: string, maps: MissionPanelMap[]) => maps.map(map =>
    mergeTaskPages(bases.get(instanceId)?.get(map.id) ?? map, pages.get(instanceId)?.get(map.id)))
  /** Reads further running, per instance and mission. */
  const running = new Map<string, Map<string, number>>()
  /** What the panel shows of reads further: running or failed, and the attention covered. */
  const pageState = (instanceId: string, missions: readonly MissionPanelMap[], pending?: { id: string; cache: MissionTaskPageCache }): Pick<MissionViewState, "taskReads" | "taskAttention"> => {
    const reads: Record<string, MissionTaskRead> = {}, attention: Record<string, MissionTaskAttentionRead> = {}
    for (const map of missions) {
      const cache = pending?.id === map.id ? pending.cache : pages.get(instanceId)?.get(map.id), count = running.get(instanceId)?.get(map.id) ?? 0
      const failure = cache && [...cache.failures.values()][0]
      if (count || failure) reads[map.id] = { loading: count > 0, ...(failure ? { failure } : {}) }
      if (cache?.attention?.windows.size) attention[map.id] = { sequence: cache.attention.sequence, windows: [...cache.attention.windows.keys()] }
    }
    return { taskReads: Object.keys(reads).length ? reads : undefined, taskAttention: Object.keys(attention).length ? attention : undefined }
  }
  const tally = (instanceId: string, missionId: string, change: number) => {
    const counts = running.get(instanceId) ?? new Map<string, number>()
    running.set(instanceId, counts)
    counts.set(missionId, Math.max(0, (counts.get(missionId) ?? 0) + change))
  }
  /** Publishes `missions` (the shown ones by default) with their reads further. */
  const publishPages = (instanceId: string, missions = peek(instanceId).missions) =>
    update(instanceId, { ...peek(instanceId), missions, ...pageState(instanceId, missions) })

  const state = (instanceId: string) => states().get(instanceId) ?? EMPTY_STATE
  // Store actions run inside callers' effects: reading state there must not
  // subscribe them to this store's publications.
  const peek = (instanceId: string) => untrack(() => state(instanceId))
  const wanted = (instanceId: string) => [...new Set(wants.get(instanceId)?.values() ?? [])].slice(0, MISSION_LIST_MAX_INCLUDE)
  /** A wanted row whose full map a summaries backend has not sent yet. */
  const missing = (value: MissionViewState, instanceId: string) => value.summariesVersion !== undefined
    ? wanted(instanceId).filter(id => value.summaries.some(row => row.id === id) && !value.missions.some(mission => mission.id === id)) : []

  const update = (instanceId: string, value: MissionViewState): void => {
    setStates((current) => {
      const next = new Map(current)
      next.set(instanceId, value)
      return next
    })
  }

  const performRefresh = async (instanceId: string): Promise<void> => {
    const generation = (generations.get(instanceId) ?? 0) + 1
    generations.set(instanceId, generation)
    const previous = peek(instanceId), cancelled = cancellations.get(instanceId)
    update(instanceId, { ...previous, status: "loading", error: undefined })
    // Only a backend that answered with summaries understands includes and versions.
    const include = wanted(instanceId)
    const request: MissionListRequest = previous.summariesVersion === undefined ? {} : { ...(include.length ? { include } : {}), summariesVersion: previous.summariesVersion }
    requested.set(instanceId, request.include ?? [])
    try {
      const response = await fetchMissions(instanceId, request)
      if (generations.get(instanceId) !== generation) return
      if (!response.available) {
        update(instanceId, { status: "unavailable", missions: [], summaries: [], reason: response.reason,
          ...(previous.cleanups?.length ? { cleanups: previous.cleanups, cleanupUnavailable: true } : {}) })
        return
      }
      // A list without summaries carries every map; an omitted list repeats the
      // version this read sent.
      const summaries = response.summariesVersion === undefined ? response.missions.map(missionSummary)
        : response.summaries ?? (response.summariesVersion === request.summariesVersion ? previous.summaries : undefined)
      if (!summaries) throw new Error("Mission list omitted summaries this view does not hold")
      // Rows wanted now that this read neither asked for nor got as open maps
      // (the first summaries answer, or a selection changed while it ran): their
      // maps from the last good display stay, with their activity, until the
      // one follow-up read for the current includes replaces them.
      const rows = new Set(summaries.map(row => row.id)), returned = new Set(response.missions.map(mission => mission.id))
      const stale = response.summariesVersion === undefined ? []
        : wanted(instanceId).filter(id => rows.has(id) && !returned.has(id) && !request.include?.includes(id))
      const retained = previous.missions.filter(mission => stale.includes(mission.id))
      const retainedActivity = previous.activity?.missions.filter(item => retained.some(mission => mission.id === item.missionId)) ?? []
      // The returned maps are the bases pages merge against; rows read further belong to
      // listed paged maps, and go (their reads stay) when a map's order changed.
      const owned = pages.get(instanceId), own = bases.get(instanceId) ?? new Map<string, MissionPanelMap>()
      bases.set(instanceId, own)
      for (const map of response.missions) own.set(map.id, map)
      for (const map of response.missions) {
        const cache = owned?.get(map.id)
        if (cache && map.taskPage && cache.order !== map.taskPage.order) reorderTaskPageCache(cache, map.taskPage.order)
        // Another attention sequence, whatever the order: the windows read cover nothing of it.
        const sequence = map.taskPage?.attention?.sequence
        if (cache && sequence) coverAttention(cache, sequence, map.revision)
      }
      const listed = [...response.missions, ...retained]
      for (const id of [...own.keys()]) if (!listed.some(map => map.id === id)) own.delete(id)
      for (const id of [...owned?.keys() ?? []]) if (!listed.some(map => map.id === id && map.taskPage)) owned!.delete(id)
      // Rows read further stay shown with the maps of the same display order (`mergeTaskPages`).
      const next: MissionViewState = {
        status: "ready",
        projectID: response.projectID,
        missions: withPages(instanceId, listed),
        summaries,
        ...(response.summariesVersion === undefined ? {} : { summariesVersion: response.summariesVersion }),
        generatedAt: response.generatedAt,
        discardedEvents: response.discardedEvents,
        activity: retainedActivity.length ? { ...response.activity, missions: [...response.activity.missions, ...retainedActivity] } : response.activity,
        cleanups: response.cleanupUnavailable || response.cleanups === undefined ? previous.cleanups ?? [] : response.cleanups,
        ...(response.cleanupUnavailable ? { cleanupUnavailable: true } : {}),
        ...pageState(instanceId, listed),
      }
      update(instanceId, next)
      // What was read before a map's revision is read again: each read vouches only for itself.
      for (const map of response.missions) {
        const cache = owned?.get(map.id)
        if (cache && map.taskPage && (!demand.has(instanceId) || wanted(instanceId).includes(map.id))) {
          for (const request of taskRequestsOf(cache, MISSION_TASK_PAGE, map.revision)) void readTasks(instanceId, map.id, request)
        }
      }
      // A deactivation since this read started cancelled its follow-up: activation reads again.
      if (stale.length && cancellations.get(instanceId) === cancelled) trailing.add(instanceId)
    } catch (error) {
      if (generations.get(instanceId) !== generation) return
      // A failed read stays parked: only new demand, an invalidation or an explicit retry reads again.
      update(instanceId, {
        ...previous,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (generations.get(instanceId) === generation) requested.delete(instanceId)
    }
  }

  /** One page read of a listed paged map, after the mission's reads before it: merged into
   * the map shown, against the list read's own map, when it answers in the same order;
   * else dropped for the next list read, which reads it again in its order (the request is
   * recorded first). */
  function readTasks(instanceId: string, missionId: string, request: MissionTaskRequest): Promise<MissionTaskReadResult> {
    const deadline = performance.now() + TASK_READ_TIMEOUT_MS
    request = structuredClone(request)
    const key = JSON.stringify([instanceId, missionId]), epoch = epochs.get(instanceId) ?? 0
    // No indefinite unowned reads: callers register selection/reader ownership first.
    if (![...wants.get(instanceId)?.values() ?? []].includes(missionId)) return Promise.resolve("skipped")
    const owner = acquireOwner(instanceId, missionId), ownership = owner.generation
    // The same request already waiting in this mission's chain is that read.
    const signature = JSON.stringify([key, epoch, ownership, request])
    const waiting = queuedReads.get(signature)
    if (waiting) return waiting
    const shownMap = peek(instanceId).missions.find(value => value.id === missionId), order = shownMap?.taskPage?.order
    if (!shownMap || !order || !fetchTasks) return Promise.resolve("skipped")
    const owned = pages.get(instanceId) ?? new Map<string, MissionTaskPageCache>()
    pages.set(instanceId, owned)
    let cache = owned.get(missionId)
    if (!cache) owned.set(missionId, cache = createTaskPageCache(order))
    else if (cache.order !== order) reorderTaskPageCache(cache, order)
    recordTaskRequest(cache, request)
    const base = bases.get(instanceId)?.get(missionId) ?? shownMap
    const attention = base.taskPage?.attention
    const context: MissionTaskPageContext = { revision: base.revision, order, total: base.taskPage!.total, reports: base.taskPage!.reports,
      counts: { ...base.taskPage!.counts }, excludedKeys: base.tasks.map(task => task.key),
      ...(attention ? { attention: { sequence: attention.sequence, omitted: attention.omitted, ...(attention.keys ? { keys: [...attention.keys] } : {}) } } : {}) }
    let lifetime = taskLifetimes.get(instanceId)
    if (!lifetime) taskLifetimes.set(instanceId, lifetime = new AbortController())
    const signal = AbortSignal.any([lifetime.signal, owner.controller.signal, AbortSignal.timeout(Math.max(0, Math.ceil(deadline - performance.now())))])
    const current = () => (epochs.get(instanceId) ?? 0) === epoch && pages.get(instanceId)?.get(missionId) === cache
      && ownerLifetimes.get(instanceId)?.get(missionId) === owner && owner.active && owner.generation === ownership
      && peek(instanceId).projectID === shownMap.projectID && peek(instanceId).missions.some(map => map.id === missionId && map.taskPage?.order === order)
    const assertCurrent = () => {
      if (!current()) throw new DOMException("Obsolete task owner", "AbortError")
      assertTaskReadLive(signal, deadline)
    }
    tally(instanceId, missionId, 1)
    publishPages(instanceId)
    const run = async (): Promise<MissionTaskReadResult> => {
      if (queuedReads.get(signature) === next) queuedReads.delete(signature)
      assertCurrent()
      const response = await raceTaskRead(fetchTasks(instanceId, missionId, { ...request, order }, { projectID: shownMap.projectID, current, signal, deadline, context }), signal)
      assertCurrent()
      if (!response.available) throw new MissionTaskPageReadError("unavailable")
      if (response.projectID !== shownMap.projectID || response.missionID !== missionId) throw new MissionTaskPageReadError("invalid")
      const latest = peek(instanceId).missions.find(value => value.id === missionId)
      if ("refused" in response || response.taskPage.order !== latest?.taskPage?.order || cache.order !== response.taskPage.order) {
        if (!("refused" in response) || response.refused === "order-changed") void refresh(instanceId)
        return "reordered"
      }
      assertCurrent()
      const candidate: MissionTaskPageCache = { ...cache, rows: new Map(cache.rows), reports: new Map(cache.reports), reads: new Map(cache.reads),
        parked: new Map(cache.parked), failures: new Map(cache.failures),
        ...(cache.attention ? { attention: { ...cache.attention, windows: new Map(cache.attention.windows) } } : {}) }
      answerTaskRequest(candidate, request, response.revision ?? 0, { ...response, attention: response.taskPage.attention })
      const base = bases.get(instanceId)?.get(missionId)
      const missions = peek(instanceId).missions.map(map => map.id === missionId ? mergeTaskPages(base ?? map, candidate) : map)
      const publication = { ...peek(instanceId), missions, ...pageState(instanceId, missions, { id: missionId, cache: candidate }) }
      assertCurrent() // after all validation/merge work, before cache or signal publication
      Object.assign(cache, candidate)
      update(instanceId, publication)
      return "read"
    }
    const queued = (pageReads.get(key) ?? Promise.resolve()).then(run, run)
    const next = (async (): Promise<MissionTaskReadResult> => {
      try {
        return await raceTaskRead(queued, signal)
      } catch (error) {
        // A failure keeps the rows shown and parks the read, its failure shown until a read
        // answers it; an explicit read further or a later revision tries again.
        if (!current() || error instanceof Error && error.name === "AbortError") return "skipped"
        failTaskRequest(cache, request, shownMap.revision, error instanceof Error ? error.message : String(error),
          error instanceof MissionTaskPageReadError ? error.reason : error instanceof Error && error.name === "TimeoutError" ? "deadline" : undefined)
        return "failed"
      } finally {
        if ((epochs.get(instanceId) ?? 0) === epoch) { tally(instanceId, missionId, -1); publishPages(instanceId) }
      }
    })()
    pageReads.set(key, next)
    queuedReads.set(signature, next)
    void next.finally(() => {
      if (pageReads.get(key) === next) pageReads.delete(key)
      if (queuedReads.get(signature) === next) queuedReads.delete(signature)
    })
    return next
  }

  const refresh = async (instanceId: string): Promise<void> => {
    const pending = inFlight.get(instanceId)
    if (pending) {
      trailing.add(instanceId)
      await pending
      return
    }
    const run = (async () => {
      do {
        trailing.delete(instanceId)
        await performRefresh(instanceId)
      } while (trailing.has(instanceId))
    })()
    inFlight.set(instanceId, run)
    try { await run }
    finally {
      if (inFlight.get(instanceId) === run) inFlight.delete(instanceId)
    }
  }

  return {
    state,
    trackedInstanceIds: () => [...states().keys()],
    demandedInstanceIds: () => [...new Set([...demand, ...readerDemand.keys()])],
    setDemand: (instanceId, demanded) => {
      if (demanded) demand.add(instanceId)
      else {
        demand.delete(instanceId)
        trailing.delete(instanceId)
        cancellations.set(instanceId, (cancellations.get(instanceId) ?? 0) + 1)
      }
    },
    want: (instanceId, owner, missionId, taskReader = false) => untrack(() => {
      const owners = wants.get(instanceId) ?? new Map<string, string>()
      const readers = readerDemand.get(instanceId) ?? new Set<string>()
      if (missionId && taskReader) readers.add(owner)
      else readers.delete(owner)
      if (readers.size) readerDemand.set(instanceId, readers)
      else readerDemand.delete(instanceId)
      if (owners.get(owner) === missionId) return
      const previous = owners.get(owner)
      if (missionId) owners.set(owner, missionId)
      else owners.delete(owner)
      if (owners.size) wants.set(instanceId, owners)
      else wants.delete(instanceId)
      if (previous && ![...owners.values()].includes(previous)) {
        const lifetime = ownerLifetimes.get(instanceId)?.get(previous)
        if (lifetime) { lifetime.active = false; lifetime.generation = ++ownershipGeneration; lifetime.controller.abort() }
        ownerLifetimes.get(instanceId)?.delete(previous)
        if (ownerLifetimes.get(instanceId)?.size === 0) ownerLifetimes.delete(instanceId)
      }
      if (missionId) acquireOwner(instanceId, missionId)
      const current = peek(instanceId)
      // Already asked for by the read in flight, or held: nothing to read.
      if (!missionId || current.status === "idle" || requested.get(instanceId)?.includes(missionId)) return
      if (missing(current, instanceId).includes(missionId)) void refresh(instanceId)
    }),
    ensure: async (instanceId) => {
      if (peek(instanceId).status !== "idle") return
      await refresh(instanceId)
    },
    refresh,
    loadTasks: (instanceId, missionId, request) => readTasks(instanceId, missionId, request),
    invalidateTasks: instanceId => {
      if (!pages.has(instanceId)) return
      epochs.set(instanceId, (epochs.get(instanceId) ?? 0) + 1)
      taskLifetimes.get(instanceId)?.abort()
      taskLifetimes.delete(instanceId)
      for (const cache of pages.get(instanceId)?.values() ?? []) cache.parked.clear()
      running.delete(instanceId)
      publishPages(instanceId)
    },
    clear: (instanceId) => {
      generations.set(instanceId, (generations.get(instanceId) ?? 0) + 1)
      epochs.set(instanceId, (epochs.get(instanceId) ?? 0) + 1)
      taskLifetimes.get(instanceId)?.abort()
      taskLifetimes.delete(instanceId)
      pages.delete(instanceId)
      for (const lifetime of ownerLifetimes.get(instanceId)?.values() ?? []) lifetime.controller.abort()
      ownerLifetimes.delete(instanceId)
      bases.delete(instanceId)
      running.delete(instanceId)
      demand.delete(instanceId)
      trailing.delete(instanceId)
      requested.delete(instanceId)
      setStates((current) => {
        if (!current.has(instanceId)) return current
        const next = new Map(current)
        next.delete(instanceId)
        return next
      })
    },
  }
}
