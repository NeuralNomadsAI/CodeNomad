import { createSignal, untrack } from "solid-js"

import type { MissionActivityProjection, MissionPanelMap, MissionSummary } from "../../../server/src/api-types"
import type { MissionCleanup, MissionUnavailableReason } from "../../../server/src/missions/model"
import { MISSION_TASK_PAGE, type MissionTaskPageResponse, type MissionTaskRequest } from "../../../server/src/missions/mission-panel-map"
import { MissionTaskPageReadError, type MissionTaskPageFailure } from "../lib/mission-task-page-read"
import { shareUnchanged } from "../lib/structural-share"
import { assertTaskReadLive, raceTaskRead, TASK_READ_TIMEOUT_MS } from "../lib/mission-task-read-lifetime"
import type { MissionTaskPageContext } from "../lib/mission-task-page-schema"
import { answerTaskRequest, coverAttention, createTaskPageCache, failTaskRequest, mergeTaskPages, recordTaskRequest, recordMissionRowRevision, missionPinnedIdentity, missionTaskSource, reorderTaskPageCache, taskRequestsOf,
  type MissionTaskPageCache } from "./mission-task-pages"

export type MissionLoadStatus = "idle" | "loading" | "ready" | "unavailable" | "error"

export interface MissionViewState {
  status: MissionLoadStatus
  projectID?: string
  /** Compact maps (`compactMissionMap`) of the wanted missions, as their owner adopted them (`adoptPanelMaps`). */
  missions: MissionPanelMap[]
  /** One row per mission, in display order. */
  summaries: MissionSummary[]
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

/** A rows read: the project's rows in display order, or why Missions cannot be read. A read
 * past `panelDeadline`, or one `panelCurrent` disowns, never publishes. */
export type MissionRowsResponse = ({ available: false; reason: MissionUnavailableReason }
  | { available: true; projectID: string; summaries: MissionSummary[]; generatedAt: number; discardedEvents: number
    cleanups?: MissionCleanup[]; cleanupUnavailable?: boolean }) & { panelDeadline?: number; panelCurrent?: () => boolean }
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
  ensure(instanceId: string, signal?: AbortSignal): Promise<void>
  refresh(instanceId: string, signal?: AbortSignal): Promise<void>
  /** Reads more of a listed paged map's tasks, a window or tasks by name, into that map. */
  loadTasks(instanceId: string, missionId: string, request: MissionTaskRequest): Promise<MissionTaskReadResult>
  /** Fence in-flight task slices on a connection/plugin transition, retaining last-good rows. */
  invalidateTasks(instanceId: string): void
  clear(instanceId: string): void
  /** Publishes the wanted missions' maps; display-only, after its caller's lifetime checks. */
  adoptPanelMaps(instanceId: string, projectID: string, maps: MissionPanelMap[], deadline?: number, signal?: AbortSignal): void
}

/** The rows of a project's Missions and the maps its owner adopts for the wanted ones, with
 * the pages read further into each map's tasks. */
export function createMissionStore(fetchRows: (instanceId: string, signal?: AbortSignal) => Promise<MissionRowsResponse>,
  fetchTasks?: MissionTaskFetch, signalForInstance?: (id: string) => AbortSignal): MissionStore {
  const [states, setStates] = createSignal(new Map<string, MissionViewState>())
  const generations = new Map<string, number>()
  const demand = new Set<string>()
  const inFlight = new Map<string, { done: Promise<void>; signal?: AbortSignal }>()
  const queuedSignals = new Map<string, AbortSignal | undefined>()
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
  /** Rows read further, per instance and mission, and the chain of each mission's page reads. */
  const pages = new Map<string, Map<string, MissionTaskPageCache>>()
  const pageReads = new Map<string, { done: Promise<MissionTaskReadResult>; signal?: AbortSignal }>(), queuedReads = new Map<string, Promise<MissionTaskReadResult>>()
  /** The adopted maps, per instance and mission: every page merges against them. */
  const bases = new Map<string, Map<string, MissionPanelMap>>()
  /** Bumped by `clear`: a page read of an earlier epoch never publishes. */
  const epochs = new Map<string, number>()
  const taskLifetimes = new Map<string, AbortController>()
  const revalidateTasks = new Set<string>()
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
  // Publications keep every unchanged part of the previous state (maps, rows, activity
  // entries): keyed lists and memos then update only the missions that changed.
  const update = (instanceId: string, value: MissionViewState): void => {
    setStates((current) => {
      const previous = current.get(instanceId), shared = shareUnchanged(previous, value, missionPinnedIdentity)
      if (shared === previous) return current
      const next = new Map(current)
      next.set(instanceId, shared)
      return next
    })
  }

  const performRefresh = async (instanceId: string, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return
    const generation = (generations.get(instanceId) ?? 0) + 1
    generations.set(instanceId, generation)
    const previous = peek(instanceId)
    update(instanceId, { ...previous, status: "loading", error: undefined })
    try {
      const response = await fetchRows(instanceId, signal)
      if (signal?.aborted || generations.get(instanceId) !== generation || response.panelCurrent && !response.panelCurrent()) return
      if (!response.available) {
        update(instanceId, { status: "unavailable", missions: [], summaries: [], reason: response.reason,
          ...(previous.cleanups?.length ? { cleanups: previous.cleanups, cleanupUnavailable: true } : {}) })
        return
      }
      if (response.panelDeadline !== undefined) assertTaskReadLive(undefined, response.panelDeadline)
      const current = peek(instanceId)
      update(instanceId, { ...current, status: "ready", projectID: response.projectID, summaries: response.summaries, error: undefined, reason: undefined,
        missions: current.missions.filter(map => map.projectID === response.projectID), generatedAt: response.generatedAt,
        cleanups: response.cleanups, cleanupUnavailable: response.cleanupUnavailable, discardedEvents: response.discardedEvents })
    } catch (error) {
      if (signal?.aborted || generations.get(instanceId) !== generation) return
      if (error instanceof Error && error.name === "AbortError") {
        update(instanceId, { ...peek(instanceId), status: previous.status === "loading" ? "ready" : previous.status })
        return
      }
      // A failed read stays parked: only new demand, an invalidation or an explicit retry reads again.
      update(instanceId, {
        ...previous,
        status: error instanceof MissionTaskPageReadError && error.unavailableReason ? "unavailable" : "error",
        reason: error instanceof MissionTaskPageReadError ? error.unavailableReason : undefined,
        error: error instanceof MissionTaskPageReadError && error.unavailableReason ? undefined : error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (generations.get(instanceId) === generation) {
        if (signal?.aborted) update(instanceId, { ...peek(instanceId), status: previous.status === "loading" ? previous.projectID ? "ready" : "idle" : previous.status })
      }
    }
  }

  /** One page read of a listed paged map, after the mission's reads before it: merged into
   * the map shown, against the list read's own map, when it answers in the same order;
   * else dropped for the next list read, which reads it again in its order (the request is
   * recorded first). */
  function readTasks(instanceId: string, missionId: string, request: MissionTaskRequest, attachment = signalForInstance?.(instanceId)): Promise<MissionTaskReadResult> {
    if (attachment?.aborted) return Promise.resolve("skipped")
    const deadline = performance.now() + TASK_READ_TIMEOUT_MS
    request = structuredClone(request)
    const epoch = epochs.get(instanceId) ?? 0
    // No indefinite unowned reads: callers register selection/reader ownership first.
    if (![...wants.get(instanceId)?.values() ?? []].includes(missionId)) return Promise.resolve("skipped")
    const owner = acquireOwner(instanceId, missionId), ownership = owner.generation
    const key = JSON.stringify([instanceId, missionId, epoch, ownership])
    // The same request already waiting in this mission's chain is that read.
    const signature = JSON.stringify([key, epoch, ownership, request])
    const waiting = queuedReads.get(signature)
    if (waiting && queuedSignals.get(signature) === attachment) return waiting
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
    const cancellation = AbortSignal.any([lifetime.signal, owner.controller.signal, ...(attachment ? [attachment] : [])])
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(Math.max(0, Math.ceil(deadline - performance.now())))])
    const current = () => !cancellation.aborted && (epochs.get(instanceId) ?? 0) === epoch && pages.get(instanceId)?.get(missionId) === cache
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
        if (!("refused" in response) || response.refused === "order-changed") void refresh(instanceId, attachment)
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
    const prior = pageReads.get(key)
    const queued = (prior && prior.signal === attachment ? prior.done : Promise.resolve()).then(run, run)
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
    const flight = { done: next, signal: attachment }
    pageReads.set(key, flight)
    queuedReads.set(signature, next)
    queuedSignals.set(signature, attachment)
    void next.finally(() => {
      if (pageReads.get(key) === flight) pageReads.delete(key)
      if (queuedReads.get(signature) === next) { queuedReads.delete(signature); queuedSignals.delete(signature) }
    })
    return next
  }

  const refresh = async (instanceId: string, signal = signalForInstance?.(instanceId)): Promise<void> => {
    if (signal?.aborted) return
    const pending = inFlight.get(instanceId)
    if (pending && pending.signal === signal) {
      trailing.add(instanceId)
      await pending.done
      return
    }
    const flight = { done: Promise.resolve(), signal }
    inFlight.set(instanceId, flight)
    const run = (async () => {
      do {
        if (inFlight.get(instanceId) !== flight) return
        trailing.delete(instanceId)
        await performRefresh(instanceId, signal)
      } while (inFlight.get(instanceId) === flight && !signal?.aborted && trailing.has(instanceId))
    })()
    flight.done = run
    try { await run }
    finally {
      if (inFlight.get(instanceId) === flight) inFlight.delete(instanceId)
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
      // Its owner reads the map and adopts it (`adoptPanelMaps`).
      if (missionId) acquireOwner(instanceId, missionId)
    }),
    ensure: async (instanceId, signal = signalForInstance?.(instanceId)) => {
      if (peek(instanceId).status !== "idle") return
      await refresh(instanceId, signal)
    },
    refresh,
    loadTasks: (instanceId, missionId, request) => readTasks(instanceId, missionId, request),
    invalidateTasks: instanceId => {
      inFlight.delete(instanceId)
      generations.set(instanceId, (generations.get(instanceId) ?? 0) + 1)
      trailing.delete(instanceId)
      revalidateTasks.add(instanceId)
      if (!pages.has(instanceId)) return
      epochs.set(instanceId, (epochs.get(instanceId) ?? 0) + 1)
      taskLifetimes.get(instanceId)?.abort()
      taskLifetimes.delete(instanceId)
      for (const cache of pages.get(instanceId)?.values() ?? []) {
        cache.parked.clear()
        for (const unit of cache.reads.keys()) cache.reads.set(unit, 0)
        for (const row of [...cache.rows.values(), ...cache.reports.values()]) { row.revision = 0; recordMissionRowRevision([row.value], 0) }
      }
      running.delete(instanceId)
      publishPages(instanceId)
    },
    clear: (instanceId) => {
      inFlight.delete(instanceId)
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
      setStates((current) => {
        if (!current.has(instanceId)) return current
        const next = new Map(current)
        next.delete(instanceId)
        return next
      })
    },
    adoptPanelMaps: (instanceId, projectID, maps, deadline = Infinity, signal = signalForInstance?.(instanceId)) => {
      if (signal?.aborted) return
      const previous = peek(instanceId)
      if (previous.projectID && previous.projectID !== projectID) {
        epochs.set(instanceId, (epochs.get(instanceId) ?? 0) + 1); taskLifetimes.get(instanceId)?.abort(); taskLifetimes.delete(instanceId)
        bases.delete(instanceId); pages.delete(instanceId)
      }
      const own = bases.get(instanceId) ?? new Map<string, MissionPanelMap>(), owned = pages.get(instanceId)
      const changedSources = new Set(maps.filter(map => revalidateTasks.has(instanceId) || missionTaskSource(own.get(map.id)) !== missionTaskSource(map)).map(map => map.id))
      bases.set(instanceId, own)
      for (const map of maps) {
        own.set(map.id, map)
        const cache = owned?.get(map.id)
        if (cache && map.taskPage) {
          if (cache.order !== map.taskPage.order) reorderTaskPageCache(cache, map.taskPage.order)
          if (map.taskPage.attention) coverAttention(cache, map.taskPage.attention.sequence, map.revision)
        }
      }
      for (const id of own.keys()) if (!maps.some(map => map.id === id)) { own.delete(id); owned?.delete(id) }
      const missions = withPages(instanceId, maps)
      assertTaskReadLive(undefined, deadline)
      update(instanceId, { ...previous, projectID, missions, ...pageState(instanceId, missions) })
      for (const map of maps.filter(map => changedSources.has(map.id))) {
        const cache = owned?.get(map.id)
        if (cache && map.taskPage) for (const request of taskRequestsOf(cache, MISSION_TASK_PAGE, map.revision)) void readTasks(instanceId, map.id, request, signal)
      }
      revalidateTasks.delete(instanceId)
    },
  }
}
