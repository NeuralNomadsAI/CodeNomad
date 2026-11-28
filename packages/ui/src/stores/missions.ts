import { backendOf } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { createEventRefreshScheduler, type RefreshUrgency } from "../lib/event-refresh-scheduler"
import { backendEvents as serverEvents } from "../lib/server-events"
import { createMissionPanelInventory } from "./mission-panel-inventory"
import { instances } from "./instances"
import { projectScope, parseInstanceKey } from "../lib/backend-identity"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { createRoot, createComputed, untrack } from "solid-js"

export const missionStore = createMissionPanelInventory({
  signal: id => captureBackendOperation(id).signal,
  scope: instanceId => { const instance = instances().get(instanceId); return instance ? projectScope(instance) : instanceId },
  projectID: instanceId => instances().get(instanceId)?.metadata?.project?.id,
  capture: instanceId => {
    const origin = instances().get(instanceId), client = origin?.client, folder = origin?.folder, projectID = origin?.metadata?.project?.id, generation = getOpenCodeInstanceGeneration(instanceId)
    return () => instances().get(instanceId)?.client === client && instances().get(instanceId)?.folder === folder
      && instances().get(instanceId)?.metadata?.project?.id === projectID && getOpenCodeInstanceGeneration(instanceId) === generation
  },
  read: (instanceId, selector, scope) => {
    const origin = instances().get(instanceId), client = origin?.client, folder = origin?.folder, generation = getOpenCodeInstanceGeneration(instanceId)
    return backendOf(instanceId).api.fetchMissionPanel(parseInstanceKey(instanceId).workspaceId, selector, { ...scope, projectID: scope.projectID ?? origin?.metadata?.project?.id,
      current: () => scope.current() && instances().get(instanceId)?.client === client && instances().get(instanceId)?.folder === folder && getOpenCodeInstanceGeneration(instanceId) === generation })
  },
  tasks: (instanceId, missionId, request, scope) => {
    const origin = instances().get(instanceId), client = origin?.client, folder = origin?.folder, generation = getOpenCodeInstanceGeneration(instanceId)
    return backendOf(instanceId).api.fetchMissionTasks(parseInstanceKey(instanceId).workspaceId, missionId, request, { ...scope, current: () => scope.current()
      && instances().get(instanceId)?.client === client && instances().get(instanceId)?.folder === folder && getOpenCodeInstanceGeneration(instanceId) === generation })
  } })

/** Least time between a settled panel read and the next journal-change read: a running
 * mission writes its journal continuously, and each read observes every listed actor. */
export const MISSION_URGENT_REFRESH_INTERVAL_MS = 1_500

// Every native status change of a large running family is an invalidation:
// Activity revalidates at a bounded rate, journal changes promptly but spaced.
const refreshes = createEventRefreshScheduler((instanceId, signal) => {
  if (missionStore.demandedInstanceIds().includes(instanceId)) return missionStore.refresh(instanceId, false, signal)
}, { urgentIntervalMs: MISSION_URGENT_REFRESH_INTERVAL_MS })

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
    || event.type === "session.execution.succeeded"
    || event.type === "session.execution.failed"
    || event.type === "session.execution.interrupted"
    || event.type.startsWith("session.inbox.")
    || event.type.startsWith("shell.")
    || event.type.startsWith("form.")
    || event.type.startsWith("permission.")
}

/** Native activity changes the panel only while a Mission may still run: an active or
 * failed (recoverable) one, an unread later summary page, or an errored inventory. */
export function missionActivityMatters(instanceId: string): boolean {
  const state = missionStore.state(instanceId)
  return state.status === "error" || missionStore.progress(instanceId, "summaries").more
    || state.summaries.some(row => row.status === "active" || row.status === "failed")
}

function scheduleRefresh(instanceId: string, urgency: RefreshUrgency): void {
  if (missionStore.demandedInstanceIds().includes(instanceId)) refreshes.schedule(instanceId, urgency, captureBackendOperation(instanceId).signal)
}

serverEvents.on("instance.event", (event) => {
  if (event.type !== "instance.event") return
  const urgent = isMissionChangedEvent(event.event) || event.event.type === "plugin.updated"
  if (event.event.type === "plugin.updated") missionStore.invalidateTasks(event.instanceId)
  if (urgent) scheduleRefresh(event.instanceId, "urgent")
  else if (isMissionActivityEvent(event.event) && missionActivityMatters(event.instanceId)) scheduleRefresh(event.instanceId, "activity")
})

serverEvents.on("instance.eventStatus", (event) => {
  if (event.type !== "instance.eventStatus" || event.status !== "connected") return
  missionStore.invalidateTasks(event.instanceId)
  scheduleRefresh(event.instanceId, "urgent")
})

serverEvents.onOpen(backendId => {
  for (const instanceId of missionStore.trackedInstanceIds()) if (parseInstanceKey(instanceId).backendId === backendId) missionStore.invalidateTasks(instanceId)
  for (const instanceId of missionStore.demandedInstanceIds()) if (parseInstanceKey(instanceId).backendId === backendId) scheduleRefresh(instanceId, "urgent")
})

serverEvents.on("workspace.stopped", (event) => {
  if (event.type !== "workspace.stopped") return
  refreshes.cancel(event.workspaceId)
  missionStore.clear(event.workspaceId)
})

// Observe transitions, rather than only comparing endpoints when a request returns:
// client/folder/project A→B→A permanently retires the earlier operation lifetime.
createRoot(() => {
  const previous = new Map<string, { client: unknown; folder?: string; project?: string; generation: number }>()
  createComputed(() => {
    const values = instances(), ids = missionStore.trackedInstanceIds()
    for (const id of ids) {
      const instance = values.get(id), next = { client: instance?.client, folder: instance?.folder, project: instance?.metadata?.project?.id, generation: getOpenCodeInstanceGeneration(id) }, before = previous.get(id)
      previous.set(id, next)
      if (before && (before.client !== next.client || before.folder !== next.folder || before.project !== next.project || before.generation !== next.generation)) untrack(() => {
        missionStore.invalidateTasks(id); scheduleRefresh(id, "urgent")
      })
    }
    for (const id of previous.keys()) if (!ids.includes(id)) previous.delete(id)
  })
})
