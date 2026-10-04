import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import { createMissionStore } from "./mission-store"

const REFRESH_DEBOUNCE_MS = 50
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const missionStore = createMissionStore((instanceId) => serverApi.fetchMissions(instanceId))

export function activateMissionDemand(instanceId: string): void {
  missionStore.setDemand(instanceId, true)
  if (missionStore.state(instanceId).status === "idle") void missionStore.ensure(instanceId)
  else void missionStore.refresh(instanceId)
}

export function deactivateMissionDemand(instanceId: string): void {
  missionStore.setDemand(instanceId, false)
  const timer = refreshTimers.get(instanceId)
  if (timer) clearTimeout(timer)
  refreshTimers.delete(instanceId)
}

export function isMissionChangedEvent(event: { type: string }): boolean {
  return event.type === "rpc.codenomad.missions.changed"
}

export function isMissionActivityEvent(event: { type: string }): boolean {
  return event.type === "session.created"
    || event.type === "session.forked"
    || event.type === "session.moved"
    || event.type === "session.deleted"
    || event.type === "session.compaction.started"
    || event.type === "session.compaction.ended"
    || event.type === "session.compaction.failed"
    || event.type === "session.execution.started"
    || event.type === "session.status"
    || event.type === "session.execution.succeeded"
    || event.type === "session.execution.failed"
    || event.type === "session.execution.interrupted"
    || event.type === "session.idle"
    || event.type.startsWith("session.inbox.")
    || event.type.startsWith("shell.")
    || event.type.startsWith("form.")
    || event.type.startsWith("permission.")
}

function scheduleRefresh(instanceId: string): void {
  const pending = refreshTimers.get(instanceId)
  if (pending) clearTimeout(pending)
  refreshTimers.set(instanceId, setTimeout(() => {
    refreshTimers.delete(instanceId)
    if (!missionStore.demandedInstanceIds().includes(instanceId)) return
    void missionStore.refresh(instanceId)
  }, REFRESH_DEBOUNCE_MS))
}

serverEvents.on("instance.event", (event) => {
  if (event.type !== "instance.event") return
  const capabilityChanged = event.event.type === "plugin.updated"
  const visible = missionStore.demandedInstanceIds().includes(event.instanceId)
  if (!visible || (!isMissionChangedEvent(event.event) && !isMissionActivityEvent(event.event) && !capabilityChanged)) return
  scheduleRefresh(event.instanceId)
})

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type !== "instance.eventStatus" || event.status !== "connected") return
  if (missionStore.demandedInstanceIds().includes(event.instanceId)) scheduleRefresh(event.instanceId)
})

serverEvents.onOpen(() => {
  for (const instanceId of missionStore.demandedInstanceIds()) scheduleRefresh(instanceId)
})

serverEvents.on("workspace.stopped", (event) => {
  if (event.type !== "workspace.stopped") return
  const timer = refreshTimers.get(event.workspaceId)
  if (timer) clearTimeout(timer)
  refreshTimers.delete(event.workspaceId)
  missionStore.clear(event.workspaceId)
})
