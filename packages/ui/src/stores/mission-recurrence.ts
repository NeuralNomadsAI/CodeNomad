import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import type { MissionRecurrenceCurrent } from "../../../server/src/api-types"
import { backendOf } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { backendEvents as serverEvents } from "../lib/server-events"
import { parseInstanceKey } from "../lib/backend-identity"
import { instances } from "./instances"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { isMissionActivityEvent, isMissionChangedEvent } from "./missions"
import { sessionListRestored } from "./session-list-restoration"
import { eventRefreshDue, type RefreshUrgency } from "../lib/event-refresh-scheduler"
import { createMissionPanelInventory } from "./mission-panel-inventory"

interface RecurrenceEntry {
  attachment: AbortSignal
  key: string
  instanceId: string
  projectID?: string
  directory: string
  scheduleID: string
  inventory?: ReturnType<typeof createMissionPanelInventory>
  inventorySource?: string
  client: unknown
  generation: number
  currentSnapshot?: MissionRecurrenceCurrent
  error: boolean
  demand: number
  stopped: boolean
  controller?: AbortController
  timer?: ReturnType<typeof setTimeout>
  due?: number
  trailing: boolean
  /** Activity arrived during a read: reschedule from its settlement, at the bounded rate. */
  activityTrailing?: boolean
  settledAt?: number
}
const cache = new Map<string, RecurrenceEntry>()
const stoppedInstances = new Set<string>()
const [cacheVersion, setCacheVersion] = createSignal(0)
const changed = () => setCacheVersion(value => value + 1)
const cacheKey = (instanceId: string, projectID: string | undefined, directory: string, scheduleID?: string) => JSON.stringify([instanceId, projectID, directory, scheduleID])

function placed(entry: RecurrenceEntry): boolean {
  const instance = instances().get(entry.instanceId)
  return cache.get(entry.key) === entry && !entry.stopped
    && instance?.folder === entry.directory && entry.client === instance.client
    && (!entry.projectID || !instance.metadata?.project?.id || instance.metadata.project.id === entry.projectID)
    && entry.generation === getOpenCodeInstanceGeneration(entry.instanceId)
}
const current = (entry: RecurrenceEntry) => !entry.attachment.aborted && placed(entry)
function cancel(entry: RecurrenceEntry): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = undefined
  entry.trailing = false
  entry.activityTrailing = false
  entry.controller?.abort()
  entry.inventory?.setDemand(entry.instanceId, false)
  entry.controller = undefined
  changed()
}
function read(entry: RecurrenceEntry, attachment = entry.attachment): void {
  if (attachment.aborted || attachment !== entry.attachment) return
  if (!entry.demand || !current(entry)) return
  if (entry.controller) { entry.trailing = true; return }
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = undefined
  entry.trailing = false
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, attachment])
  entry.controller = controller
  changed()
  const admitted = () => !signal.aborted && entry.controller === controller && entry.demand > 0 && current(entry)
  const request = Promise.resolve().then(() => {
    if (!admitted()) throw new DOMException("Obsolete recurrence owner", "AbortError")
    return backendOf(entry.instanceId).api.fetchMissionCurrentPassage(parseInstanceKey(entry.instanceId).workspaceId, entry.scheduleID, signal)
  })
  void request.then(async value => {
    if (!admitted()) return
    if (value?.version !== 1 || typeof value.projectID !== "string"
      || entry.projectID && value.projectID !== entry.projectID) throw new Error("Foreign recurrence snapshot")
    if (value.scheduleID !== entry.scheduleID
      || value.mission && (!value.passageID || value.mission.projectID !== value.projectID)) throw new Error("Foreign passage snapshot")
    entry.currentSnapshot = value
    if (value.source) {
      const source = value.source
      const same = JSON.stringify(source) === entry.inventorySource
      if (!same) {
        entry.inventory?.clear(entry.instanceId)
        entry.inventorySource = JSON.stringify(source)
        entry.inventory = createMissionPanelInventory({ passage: source, scope: () => entry.directory, projectID: () => entry.projectID,
          signal: () => entry.attachment,
          capture: () => () => current(entry) && entry.demand > 0 && JSON.stringify(entry.currentSnapshot?.source) === JSON.stringify(source),
          read: (id, selector, scope) => backendOf(id).api.fetchMissionCurrentPanel(parseInstanceKey(id).workspaceId, source, selector, scope),
          tasks: (id, _mission, task, scope) => backendOf(id).api.fetchMissionCurrentTasks(parseInstanceKey(id).workspaceId, source, task, scope) })
      }
      const inventory = entry.inventory!
      inventory.setDemand(entry.instanceId, true); inventory.want(entry.instanceId, "passage", source.missionID, true, signal)
      await (same ? inventory.refresh(entry.instanceId, true, signal) : inventory.ensure(entry.instanceId, signal))
      if (!admitted()) return
      if (inventory.state(entry.instanceId).status !== "ready") throw new Error("Current passage header unavailable")
    } else { entry.inventory?.clear(entry.instanceId); entry.inventory = undefined; entry.inventorySource = undefined }
    entry.error = false
    changed()
  }).catch(() => {
    if (admitted()) { entry.error = true; changed() }
  }).finally(() => {
    if (entry.controller !== controller) return
    entry.controller = undefined
    entry.settledAt = Date.now()
    const trailing = entry.trailing, activity = entry.activityTrailing
    entry.trailing = false
    entry.activityTrailing = false
    changed()
    if (!signal.aborted) {
      if (trailing) read(entry, attachment)
      else if (activity) scheduleRefresh(entry, "activity")
    }
  })
}
function scheduleRefresh(entry: RecurrenceEntry, urgency: RefreshUrgency = "urgent"): void {
  if (!entry.demand || !current(entry)) return
  if (entry.controller) {
    if (urgency === "urgent") entry.trailing = true
    else entry.activityTrailing = true
    return
  }
  const now = Date.now(), due = eventRefreshDue(urgency, now, entry.settledAt)
  // Continuous activity never postpones an earlier pending read.
  if (entry.timer && entry.due! <= due) return
  if (entry.timer) clearTimeout(entry.timer)
  entry.due = due
  const attachment = entry.attachment
  entry.timer = setTimeout(() => {
    entry.timer = undefined
    read(entry, attachment)
  }, due - now)
}

/** Panel and visible central reader share one demand/read per schedule and project directory. */
export function useMissionCurrentPassage(props: {
  instanceId: () => string; projectID: () => string | undefined; directory: () => string
  active: () => boolean; refresh?: () => number
  scheduleID: () => string | undefined
}) {
  const binding = createMemo(() => {
    const instanceId = props.instanceId()
    return { instanceId, projectID: props.projectID(), directory: props.directory(), scheduleID: props.scheduleID(),
      attachment: captureBackendOperation(instanceId).signal,
      active: props.active() && Boolean(props.scheduleID()) && sessionListRestored(instanceId),
      actualDirectory: instances().get(instanceId)?.folder, actualProjectID: instances().get(instanceId)?.metadata?.project?.id,
      client: instances().get(instanceId)?.client, generation: getOpenCodeInstanceGeneration(instanceId) }
  }, undefined, { equals: (a, b) => Boolean(a && a.instanceId === b.instanceId && a.projectID === b.projectID
    && a.directory === b.directory && a.scheduleID === b.scheduleID && a.actualDirectory === b.actualDirectory && a.actualProjectID === b.actualProjectID
    && a.attachment === b.attachment && a.active === b.active && a.client === b.client && a.generation === b.generation) })
  createEffect(() => {
    const identity = binding(), scheduleID = identity.scheduleID
    // Multiple consumers can rebind before the instance's Location metadata.
    // Acquire demand only once that identity is readable, so their handoff
    // cannot keep an unread entry's demand above zero and skip its first read.
    if (!identity.active || !scheduleID || identity.actualDirectory !== identity.directory
      || identity.projectID && identity.actualProjectID && identity.projectID !== identity.actualProjectID) return
    const entry = untrack(() => {
      const key = cacheKey(identity.instanceId, identity.projectID, identity.directory, scheduleID)
      let value = cache.get(key)
      if (value && value.attachment !== identity.attachment) { cancel(value); value.attachment = identity.attachment }
      if (!value || value.client !== identity.client || value.generation !== identity.generation) {
        if (value) cancel(value)
        if (cache.size >= 64 && !cache.has(key)) {
          const oldest = [...cache.values()].find(item => !item.demand)
          if (oldest) { cancel(oldest); cache.delete(oldest.key) }
        }
        value = { key, instanceId: identity.instanceId, projectID: identity.projectID, directory: identity.directory, scheduleID, client: identity.client,
          attachment: identity.attachment,
          generation: identity.generation, error: stoppedInstances.has(identity.instanceId), demand: 0,
          stopped: stoppedInstances.has(identity.instanceId), trailing: false }
        cache.set(key, value)
      }
      if (value.demand++ === 0) read(value)
      return value
    })
    onCleanup(() => { if (--entry.demand === 0) cancel(entry) })
  })
  const state = () => {
    cacheVersion()
    const identity = binding()
    if (!identity.scheduleID) return
    const entry = cache.get(cacheKey(identity.instanceId, identity.projectID, identity.directory, identity.scheduleID))
    return entry?.client === identity.client && entry?.generation === identity.generation && placed(entry) ? entry : undefined
  }
  let previousRefresh: number | undefined, previousKey: string | undefined
  createEffect(() => {
    const identity = binding(), refresh = props.refresh?.()
    const key = cacheKey(identity.instanceId, identity.projectID, identity.directory, identity.scheduleID)
    if (previousKey === key && previousRefresh !== refresh) untrack(() => {
      const entry = cache.get(key)
      if (entry) scheduleRefresh(entry)
    })
    previousKey = key
    previousRefresh = refresh
  })
  return {
    snapshot: () => {
      const entry = state(), snapshot = entry?.currentSnapshot, inventory = entry?.inventory
      if (!snapshot || !inventory) return snapshot
      const shown = inventory.state(entry.instanceId)
      return { ...snapshot, mission: shown.missions.find(map => map.id === snapshot.source?.missionID), activity: shown.activity }
    },
    inventory: () => state()?.inventory,
    error: () => state()?.error ?? false,
    loading: () => Boolean(state()?.controller),
  }
}

serverEvents.on("instance.event", event => {
  if (event.type !== "instance.event") return
  const plugin = event.event.type === "plugin.updated"
  const changedJournal = isMissionChangedEvent(event.event), passage = changedJournal || isMissionActivityEvent(event.event)
  if (!plugin && !passage) return
  // The native relay already validates placement; filesystem aliases are not UI authority.
  for (const entry of cache.values()) {
    if (entry.instanceId !== event.instanceId) continue
    if (plugin || changedJournal) scheduleRefresh(entry)
    // Activity matters only to a running passage, or to a read that has not shown one yet.
    else if (passage && (!entry.currentSnapshot || entry.currentSnapshot.passageID || entry.error)) scheduleRefresh(entry, "activity")
  }
})
serverEvents.on("instance.eventStatus", event => {
  if (event.type !== "instance.eventStatus" || event.status !== "connected") return
  stoppedInstances.delete(event.instanceId)
  for (const entry of cache.values()) if (entry.instanceId === event.instanceId) {
    entry.stopped = false
    scheduleRefresh(entry)
  }
})
serverEvents.onOpen(backendId => {
  for (const entry of cache.values()) if (parseInstanceKey(entry.instanceId).backendId === backendId) {
    const attachment = captureBackendOperation(entry.instanceId).signal
    if (entry.attachment !== attachment) { cancel(entry); entry.attachment = attachment }
    scheduleRefresh(entry)
  }
})
serverEvents.on("workspace.stopped", event => {
  if (event.type !== "workspace.stopped") return
  stoppedInstances.add(event.workspaceId)
  for (const entry of cache.values()) if (entry.instanceId === event.workspaceId) {
    entry.stopped = true
    entry.currentSnapshot = undefined
    entry.error = true
    cancel(entry)
  }
})
