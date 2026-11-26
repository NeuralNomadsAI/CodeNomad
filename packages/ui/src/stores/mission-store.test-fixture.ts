import type { MissionPanelMap } from "../../../server/src/api-types"
import { missionSummary } from "../../../server/src/missions/mission-summary"
import { createMissionStore, type MissionRowsResponse, type MissionTaskFetch } from "./mission-store"
import { recordMissionTaskSource } from "./mission-task-pages"

/** What a test lists: a rows read's answer, its rows taken from the maps to adopt. */
export type MissionListing = { available: false; reason: Extract<MissionRowsResponse, { available: false }>["reason"] }
  | (Omit<Extract<MissionRowsResponse, { available: true }>, "summaries"> & { missions: MissionPanelMap[] })

/** A store driven as the panel inventory drives it: a rows read that settles ready adopts the listed
 * maps, whose tasks count as changed with their revision or order. */
export function listedMissionStore(list: (instanceId: string, signal?: AbortSignal) => MissionListing | Promise<MissionListing>,
  fetchTasks?: MissionTaskFetch, signalForInstance?: (id: string) => AbortSignal) {
  const listed = new Map<string, Extract<MissionListing, { available: true }>>()
  const store = createMissionStore(async (instanceId, signal) => {
    const value = await list(instanceId, signal)
    if (!value.available) return value
    for (const map of value.missions) recordMissionTaskSource(map, JSON.stringify([map.revision, map.taskPage?.order]))
    listed.set(instanceId, value)
    const { missions, ...rows } = value
    return { ...rows, summaries: missions.map(missionSummary) }
  }, fetchTasks, signalForInstance)
  const adopting = async (instanceId: string, read: Promise<void>) => {
    await read
    const value = listed.get(instanceId), state = store.state(instanceId)
    if (value && state.status === "ready" && state.projectID === value.projectID) store.adoptPanelMaps(instanceId, value.projectID, value.missions)
  }
  return { ...store,
    ensure: (instanceId: string, signal?: AbortSignal) => adopting(instanceId, store.ensure(instanceId, signal)),
    refresh: (instanceId: string, signal?: AbortSignal) => adopting(instanceId, store.refresh(instanceId, signal)) }
}
