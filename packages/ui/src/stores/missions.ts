import { serverApi } from "../lib/api-client"
import { createEventRefreshScheduler, type RefreshUrgency } from "../lib/event-refresh-scheduler"
import { serverEvents } from "../lib/server-events"
import { createMissionStore } from "./mission-store"

export const missionStore = createMissionStore((instanceId) => serverApi.fetchMissions(instanceId))

// Every native status change of a large running family is an invalidation:
// activity revalidates at a bounded rate, journal changes promptly.
const refreshes = createEventRefreshScheduler((instanceId) => {
  if (missionStore.demandedInstanceIds().includes(instanceId)) return missionStore.refresh(instanceId)
})

export function activateMissionDemand(instanceId: string): void {
  missionStore.setDemand(instanceId, true)
  if (missionStore.state(instanceId).status === "idle") void missionStore.ensure(instanceId)
  else void missionStore.refresh(instanceId)
}

export function deactivateMissionDemand(instanceId: string): void {
  missionStore.setDemand(instanceId, false)
  refreshes.cancel(instanceId)
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

function scheduleRefresh(instanceId: string, urgency: RefreshUrgency): void {
  if (missionStore.demandedInstanceIds().includes(instanceId)) refreshes.schedule(instanceId, urgency)
}

serverEvents.on("instance.event", (event) => {
  if (event.type !== "instance.event") return
  const urgent = isMissionChangedEvent(event.event) || event.event.type === "plugin.updated"
  if (urgent || isMissionActivityEvent(event.event)) scheduleRefresh(event.instanceId, urgent ? "urgent" : "activity")
})

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type !== "instance.eventStatus" || event.status !== "connected") return
  scheduleRefresh(event.instanceId, "urgent")
})

serverEvents.onOpen(() => {
  for (const instanceId of missionStore.demandedInstanceIds()) scheduleRefresh(instanceId, "urgent")
})

serverEvents.on("workspace.stopped", (event) => {
  if (event.type !== "workspace.stopped") return
  refreshes.cancel(event.workspaceId)
  missionStore.clear(event.workspaceId)
})
