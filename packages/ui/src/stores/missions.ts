import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import { createMissionStore } from "./mission-store"

const REFRESH_DEBOUNCE_MS = 50
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const missionStore = createMissionStore((instanceId) => serverApi.fetchMissions(instanceId))

export function isMissionChangedEvent(event: { type: string }): boolean {
  return event.type === "rpc.codenomad.missions.changed"
}

function scheduleRefresh(instanceId: string): void {
  const pending = refreshTimers.get(instanceId)
  if (pending) clearTimeout(pending)
  refreshTimers.set(instanceId, setTimeout(() => {
    refreshTimers.delete(instanceId)
    void missionStore.refresh(instanceId)
  }, REFRESH_DEBOUNCE_MS))
}

serverEvents.on("instance.event", (event) => {
  if (event.type !== "instance.event" || !isMissionChangedEvent(event.event)) return
  scheduleRefresh(event.instanceId)
})

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type !== "instance.eventStatus" || event.status !== "connected") return
  if (missionStore.trackedInstanceIds().includes(event.instanceId)) scheduleRefresh(event.instanceId)
})

serverEvents.onOpen(() => {
  for (const instanceId of missionStore.trackedInstanceIds()) scheduleRefresh(instanceId)
})

serverEvents.on("workspace.stopped", (event) => {
  if (event.type !== "workspace.stopped") return
  const timer = refreshTimers.get(event.workspaceId)
  if (timer) clearTimeout(timer)
  refreshTimers.delete(event.workspaceId)
  missionStore.clear(event.workspaceId)
})
