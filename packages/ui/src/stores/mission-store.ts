import { createSignal, untrack } from "solid-js"

import type { MissionActivityProjection, MissionListResponse, MissionPanelMap, MissionSummary } from "../../../server/src/api-types"
import type { MissionCleanup, MissionUnavailableReason } from "../../../server/src/missions/model"
import { MISSION_LIST_MAX_INCLUDE, missionSummary } from "../../../server/src/missions/mission-summary"

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
}

export interface MissionListRequest { include?: string[]; summariesVersion?: string }

const EMPTY_STATE: MissionViewState = { status: "idle", missions: [], summaries: [] }

export interface MissionStore {
  state(instanceId: string): MissionViewState
  trackedInstanceIds(): string[]
  demandedInstanceIds(): string[]
  setDemand(instanceId: string, demanded: boolean): void
  /** `owner` (the selection, a reader) needs `missionId`'s full map; undefined releases it. */
  want(instanceId: string, owner: string, missionId: string | undefined): void
  ensure(instanceId: string): Promise<void>
  refresh(instanceId: string): Promise<void>
  clear(instanceId: string): void
}

export function createMissionStore(fetchMissions: (instanceId: string, request: MissionListRequest) => Promise<MissionListResponse>): MissionStore {
  const [states, setStates] = createSignal(new Map<string, MissionViewState>())
  const generations = new Map<string, number>()
  const demand = new Set<string>()
  const inFlight = new Map<string, Promise<void>>()
  const trailing = new Set<string>()
  const wants = new Map<string, Map<string, string>>()
  /** The includes of each instance's read in flight. */
  const requested = new Map<string, readonly string[]>()
  /** Deactivations per instance: a read's own follow-up survives only if none happened while it ran. */
  const cancellations = new Map<string, number>()

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
      const next: MissionViewState = {
        status: "ready",
        projectID: response.projectID,
        missions: [...response.missions, ...retained],
        summaries,
        ...(response.summariesVersion === undefined ? {} : { summariesVersion: response.summariesVersion }),
        generatedAt: response.generatedAt,
        discardedEvents: response.discardedEvents,
        activity: retainedActivity.length ? { ...response.activity, missions: [...response.activity.missions, ...retainedActivity] } : response.activity,
        cleanups: response.cleanupUnavailable || response.cleanups === undefined ? previous.cleanups ?? [] : response.cleanups,
        ...(response.cleanupUnavailable ? { cleanupUnavailable: true } : {}),
      }
      update(instanceId, next)
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
    demandedInstanceIds: () => [...demand],
    setDemand: (instanceId, demanded) => {
      if (demanded) demand.add(instanceId)
      else {
        demand.delete(instanceId)
        trailing.delete(instanceId)
        cancellations.set(instanceId, (cancellations.get(instanceId) ?? 0) + 1)
      }
    },
    want: (instanceId, owner, missionId) => untrack(() => {
      const owners = wants.get(instanceId) ?? new Map<string, string>()
      if (owners.get(owner) === missionId) return
      if (missionId) owners.set(owner, missionId)
      else owners.delete(owner)
      if (owners.size) wants.set(instanceId, owners)
      else wants.delete(instanceId)
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
    clear: (instanceId) => {
      generations.set(instanceId, (generations.get(instanceId) ?? 0) + 1)
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
