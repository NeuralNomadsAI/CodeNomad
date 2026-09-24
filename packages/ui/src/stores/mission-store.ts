import { createSignal } from "solid-js"

import type { MissionListResponse, MissionMap } from "../../../server/src/api-types"

export type MissionLoadStatus = "idle" | "loading" | "ready" | "unavailable" | "error"

export interface MissionViewState {
  status: MissionLoadStatus
  missions: MissionMap[]
  reason?: "plugin-unavailable" | "workspace-unavailable"
  error?: string
  generatedAt?: number
  discardedEvents?: number
}

const EMPTY_STATE: MissionViewState = { status: "idle", missions: [] }

export interface MissionStore {
  state(instanceId: string): MissionViewState
  trackedInstanceIds(): string[]
  ensure(instanceId: string): Promise<void>
  refresh(instanceId: string): Promise<void>
  clear(instanceId: string): void
}

export function createMissionStore(fetchMissions: (instanceId: string) => Promise<MissionListResponse>): MissionStore {
  const [states, setStates] = createSignal(new Map<string, MissionViewState>())
  const generations = new Map<string, number>()

  const state = (instanceId: string) => states().get(instanceId) ?? EMPTY_STATE

  const update = (instanceId: string, value: MissionViewState): void => {
    setStates((current) => {
      const next = new Map(current)
      next.set(instanceId, value)
      return next
    })
  }

  const refresh = async (instanceId: string): Promise<void> => {
    const generation = (generations.get(instanceId) ?? 0) + 1
    generations.set(instanceId, generation)
    const previous = state(instanceId)
    update(instanceId, { ...previous, status: "loading", error: undefined })
    try {
      const response = await fetchMissions(instanceId)
      if (generations.get(instanceId) !== generation) return
      if (!response.available) {
        update(instanceId, { status: "unavailable", missions: [], reason: response.reason })
        return
      }
      update(instanceId, {
        status: "ready",
        missions: response.missions,
        generatedAt: response.generatedAt,
        discardedEvents: response.discardedEvents,
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

  return {
    state,
    trackedInstanceIds: () => [...states().keys()],
    ensure: async (instanceId) => {
      if (state(instanceId).status !== "idle") return
      await refresh(instanceId)
    },
    refresh,
    clear: (instanceId) => {
      generations.set(instanceId, (generations.get(instanceId) ?? 0) + 1)
      setStates((current) => {
        if (!current.has(instanceId)) return current
        const next = new Map(current)
        next.delete(instanceId)
        return next
      })
    },
  }
}
