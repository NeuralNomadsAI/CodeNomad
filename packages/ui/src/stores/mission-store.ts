import { createSignal } from "solid-js"

import type { MissionActivityProjection, MissionListResponse, MissionMap } from "../../../server/src/api-types"
import type { MissionCleanup } from "../../../server/src/missions/model"

export type MissionLoadStatus = "idle" | "loading" | "ready" | "unavailable" | "error"

export interface MissionViewState {
  status: MissionLoadStatus
  projectID?: string
  missions: MissionMap[]
  reason?: "plugin-unavailable" | "workspace-unavailable"
  error?: string
  generatedAt?: number
  discardedEvents?: number
  activity?: MissionActivityProjection
  cleanups?: MissionCleanup[]
  cleanupUnavailable?: boolean
}

const EMPTY_STATE: MissionViewState = { status: "idle", missions: [] }

export interface MissionStore {
  state(instanceId: string): MissionViewState
  trackedInstanceIds(): string[]
  demandedInstanceIds(): string[]
  setDemand(instanceId: string, demanded: boolean): void
  ensure(instanceId: string): Promise<void>
  refresh(instanceId: string): Promise<void>
  clear(instanceId: string): void
}

export function createMissionStore(fetchMissions: (instanceId: string) => Promise<MissionListResponse>): MissionStore {
  const [states, setStates] = createSignal(new Map<string, MissionViewState>())
  const generations = new Map<string, number>()
  const demand = new Set<string>()
  const inFlight = new Map<string, Promise<void>>()
  const trailing = new Set<string>()

  const state = (instanceId: string) => states().get(instanceId) ?? EMPTY_STATE

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
    try {
      const response = await fetchMissions(instanceId)
      if (generations.get(instanceId) !== generation) return
      if (!response.available) {
        update(instanceId, { status: "unavailable", missions: [], reason: response.reason,
          ...(previous.cleanups?.length ? { cleanups: previous.cleanups, cleanupUnavailable: true } : {}) })
        return
      }
      update(instanceId, {
        status: "ready",
        projectID: response.projectID,
        missions: response.missions,
        generatedAt: response.generatedAt,
        discardedEvents: response.discardedEvents,
        activity: response.activity,
        cleanups: response.cleanupUnavailable || response.cleanups === undefined ? previous.cleanups ?? [] : response.cleanups,
        ...(response.cleanupUnavailable ? { cleanupUnavailable: true } : {}),
      })
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
