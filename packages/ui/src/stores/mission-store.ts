import { createSignal } from "solid-js"

import type { MissionActivityProjection, MissionListResponse, MissionMap, MissionSummary } from "../../../server/src/api-types"
import type { MissionCleanup, MissionUnavailableReason } from "../../../server/src/missions/model"
import { MISSION_LIST_MAX_INCLUDE, missionSummary } from "../../../server/src/missions/mission-summary"

export type MissionLoadStatus = "idle" | "loading" | "ready" | "unavailable" | "error"

export interface MissionViewState {
  status: MissionLoadStatus
  projectID?: string
  /** Full maps: the open and wanted missions, or every one from a full snapshot. */
  missions: MissionMap[]
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

  const state = (instanceId: string) => states().get(instanceId) ?? EMPTY_STATE
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
    const previous = state(instanceId)
    update(instanceId, { ...previous, status: "loading", error: undefined })
    // Only a backend that answered with summaries understands includes and versions.
    const include = wanted(instanceId)
    const request: MissionListRequest = previous.summariesVersion === undefined ? {} : { ...(include.length ? { include } : {}), summariesVersion: previous.summariesVersion }
    try {
      const response = await fetchMissions(instanceId, request)
      if (generations.get(instanceId) !== generation) return
      if (!response.available) {
        update(instanceId, { status: "unavailable", missions: [], summaries: [], reason: response.reason,
          ...(previous.cleanups?.length ? { cleanups: previous.cleanups, cleanupUnavailable: true } : {}) })
        return
      }
      // A full snapshot (a plugin without summaries) carries every map; an
      // omitted list repeats the version this read sent.
      const summaries = response.summariesVersion === undefined ? response.missions.map(missionSummary)
        : response.summaries ?? (response.summariesVersion === request.summariesVersion ? previous.summaries : undefined)
      if (!summaries) throw new Error("Mission list omitted summaries this view does not hold")
      const next: MissionViewState = {
        status: "ready",
        projectID: response.projectID,
        missions: response.missions,
        summaries,
        ...(response.summariesVersion === undefined ? {} : { summariesVersion: response.summariesVersion }),
        generatedAt: response.generatedAt,
        discardedEvents: response.discardedEvents,
        activity: response.activity,
        cleanups: response.cleanupUnavailable || response.cleanups === undefined ? previous.cleanups ?? [] : response.cleanups,
        ...(response.cleanupUnavailable ? { cleanupUnavailable: true } : {}),
      }
      update(instanceId, next)
      // The first summaries answer names which wanted rows still need their map.
      if (missing(next, instanceId).some(id => !request.include?.includes(id))) trailing.add(instanceId)
    } catch (error) {
      if (generations.get(instanceId) !== generation) return
      update(instanceId, {
        ...previous,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      })
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
      }
    },
    want: (instanceId, owner, missionId) => {
      const owners = wants.get(instanceId) ?? new Map<string, string>()
      if (owners.get(owner) === missionId) return
      if (missionId) owners.set(owner, missionId)
      else owners.delete(owner)
      if (owners.size) wants.set(instanceId, owners)
      else wants.delete(instanceId)
      const current = state(instanceId)
      if (missionId && current.status !== "idle" && missing(current, instanceId).includes(missionId)) void refresh(instanceId)
    },
    ensure: async (instanceId) => {
      if (state(instanceId).status !== "idle") return
      await refresh(instanceId)
    },
    refresh,
    clear: (instanceId) => {
      generations.set(instanceId, (generations.get(instanceId) ?? 0) + 1)
      demand.delete(instanceId)
      trailing.delete(instanceId)
      setStates((current) => {
        if (!current.has(instanceId)) return current
        const next = new Map(current)
        next.delete(instanceId)
        return next
      })
    },
  }
}
