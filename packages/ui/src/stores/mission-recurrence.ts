import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import type { MissionRecurrenceSnapshot, MissionRecurrenceCurrent } from "../../../server/src/api-types"
import { readRecurrenceScheduleChanged } from "../../../server/src/missions/recurrence-events"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import { instances } from "./instances"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { isMissionActivityEvent, isMissionChangedEvent } from "./missions"

interface RecurrenceEntry {
  key: string
  instanceId: string
  projectID?: string
  directory: string
  scheduleID?: string
  client: unknown
  generation: number
  snapshot?: MissionRecurrenceSnapshot
  currentSnapshot?: MissionRecurrenceCurrent
  error: boolean
  demand: number
  stopped: boolean
  controller?: AbortController
  timer?: ReturnType<typeof setTimeout>
  trailing: boolean
}
const cache = new Map<string, RecurrenceEntry>()
const stoppedInstances = new Set<string>()
const [cacheVersion, setCacheVersion] = createSignal(0)
const changed = () => setCacheVersion(value => value + 1)
const cacheKey = (instanceId: string, projectID: string | undefined, directory: string, scheduleID?: string) => JSON.stringify([instanceId, projectID, directory, scheduleID])

function current(entry: RecurrenceEntry): boolean {
  const instance = instances().get(entry.instanceId)
  return cache.get(entry.key) === entry && !entry.stopped
    && instance?.folder === entry.directory && entry.client === instance.client
    && (!entry.projectID || !instance.metadata?.project?.id || instance.metadata.project.id === entry.projectID)
    && entry.generation === getOpenCodeInstanceGeneration(entry.instanceId)
}
function cancel(entry: RecurrenceEntry): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = undefined
  entry.trailing = false
  entry.controller?.abort()
  entry.controller = undefined
  changed()
}
function read(entry: RecurrenceEntry): void {
  if (!entry.demand || !current(entry)) return
  if (entry.controller) { entry.trailing = true; return }
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = undefined
  entry.trailing = false
  const controller = new AbortController()
  entry.controller = controller
  changed()
  const admitted = () => entry.controller === controller && !controller.signal.aborted && entry.demand > 0 && current(entry)
  const request = entry.scheduleID ? serverApi.fetchMissionCurrentPassage(entry.instanceId, entry.scheduleID, controller.signal)
    : serverApi.fetchMissionRecurrence(entry.instanceId, controller.signal)
  void request.then(value => {
    if (!admitted()) return
    if (value?.version !== 1 || typeof value.projectID !== "string"
      || entry.projectID && value.projectID !== entry.projectID) throw new Error("Foreign recurrence snapshot")
    if (entry.scheduleID) {
      if (!("scheduleID" in value) || value.scheduleID !== entry.scheduleID
        || value.mission && (!value.passageID || value.mission.projectID !== value.projectID)) throw new Error("Foreign passage snapshot")
      entry.currentSnapshot = value
    } else {
      if (!("schedules" in value) || !Array.isArray(value.schedules)) throw new Error("Foreign recurrence snapshot")
      entry.snapshot = value
    }
    entry.error = false
    changed()
  }).catch(() => {
    if (admitted()) { entry.error = true; changed() }
  }).finally(() => {
    if (entry.controller !== controller) return
    entry.controller = undefined
    const trailing = entry.trailing
    entry.trailing = false
    changed()
    if (trailing) read(entry)
  })
}
function scheduleRefresh(entry: RecurrenceEntry): void {
  if (!entry.demand || !current(entry)) return
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = undefined
    read(entry)
  }, 50)
}

/** List and visible central reader share one demand/read per project directory. */
interface ReadDemand {
  instanceId: () => string; projectID: () => string | undefined; directory: () => string
  active: () => boolean; refresh?: () => number
  scheduleID?: () => string | undefined
}
function useRecurrenceRead(props: ReadDemand) {
  const binding = createMemo(() => {
    const instanceId = props.instanceId()
    return { instanceId, projectID: props.projectID(), directory: props.directory(), scheduleID: props.scheduleID?.(),
      active: props.active() && (!props.scheduleID || Boolean(props.scheduleID())),
      actualDirectory: instances().get(instanceId)?.folder, actualProjectID: instances().get(instanceId)?.metadata?.project?.id,
      client: instances().get(instanceId)?.client, generation: getOpenCodeInstanceGeneration(instanceId) }
  }, undefined, { equals: (a, b) => Boolean(a && a.instanceId === b.instanceId && a.projectID === b.projectID
    && a.directory === b.directory && a.scheduleID === b.scheduleID && a.actualDirectory === b.actualDirectory && a.actualProjectID === b.actualProjectID
    && a.active === b.active && a.client === b.client && a.generation === b.generation) })
  createEffect(() => {
    const identity = binding()
    if (!identity.active) return
    const entry = untrack(() => {
      const key = cacheKey(identity.instanceId, identity.projectID, identity.directory, identity.scheduleID)
      let value = cache.get(key)
      if (!value || value.client !== identity.client || value.generation !== identity.generation) {
        if (value) cancel(value)
        if (cache.size >= 64 && !cache.has(key)) {
          const oldest = [...cache.values()].find(item => !item.demand)
          if (oldest) { cancel(oldest); cache.delete(oldest.key) }
        }
        value = { key, instanceId: identity.instanceId, projectID: identity.projectID, directory: identity.directory, scheduleID: identity.scheduleID, client: identity.client,
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
    if (props.scheduleID && !identity.scheduleID) return
    const entry = cache.get(cacheKey(identity.instanceId, identity.projectID, identity.directory, identity.scheduleID))
    return entry?.client === identity.client && entry?.generation === identity.generation && current(entry) ? entry : undefined
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
    snapshot: () => state()?.snapshot,
    currentSnapshot: () => state()?.currentSnapshot,
    error: () => state()?.error ?? false,
    stale: () => Boolean(state()?.snapshot && state()?.error),
    loading: () => Boolean(state()?.controller),
  }
}

export function useMissionRecurrence(props: Omit<ReadDemand, "scheduleID">) { return useRecurrenceRead(props) }
export function useMissionCurrentPassage(props: ReadDemand & { scheduleID: () => string | undefined }) {
  const read = useRecurrenceRead(props)
  return { snapshot: read.currentSnapshot, error: read.error, loading: read.loading }
}

serverEvents.on("instance.event", event => {
  if (event.type !== "instance.event") return
  const schedule = readRecurrenceScheduleChanged(event.event), plugin = event.event.type === "plugin.updated"
  const passage = isMissionActivityEvent(event.event) || isMissionChangedEvent(event.event)
  if (!schedule && !plugin && !passage) return
  // The native relay already validates placement; filesystem aliases are not UI authority.
  for (const entry of cache.values()) if (entry.instanceId === event.instanceId
    && (plugin || schedule && (!entry.scheduleID || entry.scheduleID === schedule.scheduleID) || passage && entry.scheduleID)) scheduleRefresh(entry)
})
serverEvents.on("instance.eventStatus", event => {
  if (event.type !== "instance.eventStatus" || event.status !== "connected") return
  stoppedInstances.delete(event.instanceId)
  for (const entry of cache.values()) if (entry.instanceId === event.instanceId) {
    entry.stopped = false
    scheduleRefresh(entry)
  }
})
serverEvents.onOpen(() => { for (const entry of cache.values()) scheduleRefresh(entry) })
serverEvents.on("workspace.stopped", event => {
  if (event.type !== "workspace.stopped") return
  stoppedInstances.add(event.workspaceId)
  for (const entry of cache.values()) if (entry.instanceId === event.workspaceId) {
    entry.stopped = true
    entry.snapshot = undefined
    entry.currentSnapshot = undefined
    entry.error = true
    cancel(entry)
  }
})
