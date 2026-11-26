import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import type { MissionScheduleRead } from "../../../server/src/api-types"
import type { ServerApi } from "../lib/api-client"
import { backendOf } from "../lib/backend-client"
import { parseInstanceKey } from "../lib/backend-identity"
import { captureBackendOperation } from "../lib/backend-operation"
import { partialMissionScheduleReceipt, pendingMissionScheduleRevision } from "../lib/mission-schedule-receipt"
import { createEventRefreshScheduler } from "../lib/event-refresh-scheduler"
import { backendEvents as serverEvents } from "../lib/server-events"
import { instances } from "./instances"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { sessionListRestored } from "./session-list-restoration"
import { isMissionActivityEvent } from "./missions"

export type UnifiedMissionSchedule = NonNullable<MissionScheduleRead["document"]>
export type UnifiedScheduleAction = Parameters<ServerApi["controlMissionSchedule"]>[2]["action"]
export type UnifiedScheduleHold = { phase: "control" | "activation" | "publication"; requestID: string; expectedRevision: number;
  action: UnifiedScheduleAction; partial: boolean; pending?: boolean; document: UnifiedMissionSchedule; minimumRevision?: number }
export const unifiedScheduleHolds = new Map<string, UnifiedScheduleHold>()
const [holdVersion, setHoldVersion] = createSignal(0)
export const changedUnifiedScheduleHolds = () => setHoldVersion(value => value + 1)
export function unifiedScheduleHold(key: string) { holdVersion(); return unifiedScheduleHolds.get(key) }

type ScheduleListCacheEntry = {
  rows: UnifiedMissionSchedule[]
  next?: string
  client: unknown
  generation: number
  attachment: AbortSignal
}
const SCHEDULE_LIST_CACHE_LIMIT = 32
const scheduleListCache = new Map<string, ScheduleListCacheEntry>()

function readScheduleListCache(scope: string, owner: { client: unknown; generation: number; attachment: AbortSignal }) {
  const entry = scheduleListCache.get(scope)
  if (!entry || entry.client !== owner.client || entry.generation !== owner.generation
    || entry.attachment !== owner.attachment || owner.attachment.aborted) return undefined
  return entry
}

function writeScheduleListCache(scope: string, entry: ScheduleListCacheEntry) {
  if (entry.attachment.aborted) return
  if (scheduleListCache.has(scope)) scheduleListCache.delete(scope)
  scheduleListCache.set(scope, entry)
  if (scheduleListCache.size > SCHEDULE_LIST_CACHE_LIMIT) {
    const oldest = scheduleListCache.keys().next().value
    if (oldest !== undefined) scheduleListCache.delete(oldest)
  }
}

/** Panel-owned bounded pages. Refresh revalidates only pages explicitly loaded;
 * selecting an object outside them uses a point read, never an inventory scan. */
export function useMissionSchedules(props: { instanceId: () => string; projectID: () => string | undefined;
  directory: () => string; active: () => boolean; refresh: () => number; selected: () => string | undefined }) {
  const binding = createMemo(() => ({ instance: props.instanceId(), project: props.projectID(), directory: props.directory(),
    attachment: captureBackendOperation(props.instanceId()).signal,
    active: props.active() && sessionListRestored(props.instanceId()), client: instances().get(props.instanceId())?.client,
    generation: getOpenCodeInstanceGeneration(props.instanceId()) }), undefined,
  { equals: (a, b) => !!a && JSON.stringify([a.instance, a.project, a.directory, a.active, a.generation])
    === JSON.stringify([b.instance, b.project, b.directory, b.active, b.generation]) && a.attachment === b.attachment && a.client === b.client })
  const [snapshot, setRows] = createSignal<UnifiedMissionSchedule[]>([]), [error, setError] = createSignal(false)
  const [selectionError, setSelectionError] = createSignal<"pending" | "failed">()
  const [fresh, setFresh] = createSignal<ReadonlySet<string>>(new Set())
  const [recovery, setRecovery] = createSignal<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = createSignal(false), [next, setNext] = createSignal<string>()
  let controller: AbortController | undefined, epoch = 0, selectionEpoch = 0, pages = 1, trailing = false
  const rows = createMemo(() => {
    const owner = binding(), collected = new Map(snapshot().map(row => [row.id, row]))
    holdVersion()
    for (const [key, hold] of unifiedScheduleHolds) {
      if (key === JSON.stringify([owner.instance, owner.project, owner.directory, hold.document.id]) && !collected.has(hold.document.id))
        collected.set(hold.document.id, hold.document)
    }
    return [...collected.values()]
  })
  const published = (owner: ReturnType<typeof binding>, documents: UnifiedMissionSchedule[]) => {
    let changed = false
    for (const doc of documents) {
      const key = JSON.stringify([owner.instance, owner.project, owner.directory, doc.id]), hold = unifiedScheduleHolds.get(key)
      if (hold?.phase === "publication" && doc.revision >= hold.minimumRevision!) {
        unifiedScheduleHolds.delete(key); changed = true
      }
    }
    if (changed) changedUnifiedScheduleHolds()
  }
  const read = async (append = false, parent = captureBackendOperation(props.instanceId()).signal) => {
    if (parent.aborted) return
    const owner = binding()
    if (!owner.active || !owner.project) return
    if (controller) { trailing = true; return }
    const captured = epoch, abort = controller = new AbortController()
    const signal = AbortSignal.any([abort.signal, parent])
    const current = () => captured === epoch && binding() === owner && !signal.aborted
    setLoading(true)
    try {
      const api = backendOf(owner.instance).api, workspaceId = parseInstanceKey(owner.instance).workspaceId
      const collected = new Map<string, UnifiedMissionSchedule>()
      let after: string | undefined = append ? next() : undefined
      for (let page = 0; page < (append ? 1 : pages); page++) {
        const value = await api.fetchMissionSchedules(workspaceId, { directory: owner.directory, after, limit: 8, kind: "schedule" }, signal)
        if (!current()) return
        if (value.projectID !== owner.project || value.version !== 1 || value.next && value.next === after) throw new Error("Foreign schedule page")
        for (const row of value.schedules) collected.set(row.id, row)
        after = value.next
        if (!after) break
      }
      const scope = JSON.stringify([owner.instance, owner.project, owner.directory])
      if (append) {
        pages++
        const merged = [...new Map([...snapshot(), ...collected.values()].map(row => [row.id, row])).values()]
        setRows(merged)
        setNext(after); setFresh(previous => new Set([...previous, ...collected.keys()]))
        setRecovery(previous => new Set([...previous].filter(id => !collected.has(id)))); setError(false)
        writeScheduleListCache(scope, { rows: merged, next: after, client: owner.client, generation: owner.generation, attachment: owner.attachment })
        published(owner, [...collected.values()])
        return
      }
      const selected = props.selected(), selectedEpoch = selectionEpoch
      const selectedCurrent = () => current() && selectedEpoch === selectionEpoch && props.selected() === selected
      const previous = snapshot().find(row => row.id === selected && !collected.has(row.id))
      // Inventory and its cursor are valid independently of the selected read.
      // Keep the selected display/pointer target while its revalidation runs.
      const nextRows = [...collected.values(), ...(previous ? [previous] : [])]
      setRows(nextRows); setNext(after)
      setFresh(new Set([...collected.keys(), ...(previous && fresh().has(previous.id) ? [previous.id] : [])]))
      setRecovery(previousSet => new Set([...previousSet].filter(id => id === previous?.id && !collected.has(id))))
      setError(false)
      writeScheduleListCache(scope, { rows: nextRows, next: after, client: owner.client, generation: owner.generation, attachment: owner.attachment })
      published(owner, [...collected.values()])
      if (selected && !collected.has(selected)) {
        try {
          const value = await api.fetchMissionSchedule(workspaceId, selected, { directory: owner.directory }, signal)
          if (!selectedCurrent()) return
          if (value.document && value.document.id !== selected) throw new Error("Foreign selected schedule")
          if (value.document) collected.set(selected, value.document)
          const resolvedRows = [...collected.values()]
          setRows(resolvedRows)
          writeScheduleListCache(scope, { rows: resolvedRows, next: after, client: owner.client, generation: owner.generation, attachment: owner.attachment })
          setSelectionError(value.pending ? "pending" : undefined)
          setFresh(previous => new Set([...previous].filter(id => id !== selected).concat(!value.pending && value.document ? [selected] : [])))
          setRecovery(previousSet => new Set([...previousSet].filter(id => id !== selected)
            .concat(value.pending && value.document && Number.isSafeInteger(value.document.revision) ? [selected] : [])))
          if (!value.pending && value.document) published(owner, [value.document])
        } catch (error) {
          if (!selectedCurrent()) return
          const receipt = partialMissionScheduleReceipt(error)
          const pending = pendingMissionScheduleRevision(error)
          setFresh(previous => new Set([...previous].filter(id => id !== selected)))
          const eligible = pending?.document.id === selected && previous?.id === selected && previous.revision === pending.document.revision
          setRecovery(previousSet => new Set([...previousSet].filter(id => id !== selected).concat(eligible ? [selected] : [])))
          setSelectionError(receipt?.document?.id === selected || pending?.document.id === selected ? "pending" : "failed")
        }
      } else if (selectedCurrent()) {
        setSelectionError(undefined)
      }
    } catch { if (current()) setError(true) }
    finally {
      if (controller === abort) { controller = undefined; setLoading(false) }
      if (trailing && current()) { trailing = false; scheduler.schedule("list", "urgent", parent) }
    }
  }
  const scheduler = createEventRefreshScheduler((_key, signal) => read(false, signal))
  const schedule = (urgency: "urgent" | "activity" = "urgent") => scheduler.schedule("list", urgency, captureBackendOperation(props.instanceId()).signal)
  let displayScope: string | undefined
  createEffect(() => {
    const owner = binding()
    epoch++; controller?.abort(); controller = undefined; trailing = false
    const scope = JSON.stringify([owner.instance, owner.project, owner.directory])
    if (scope !== displayScope) {
      const cached = readScheduleListCache(scope, owner)
      setRows(cached ? cached.rows : [])
      setNext(cached?.next)
      // The cache shows what was loaded at once; revalidation restarts from the first page and
      // its cursor, so the selected schedule never waits for every page loaded before.
      pages = 1
    }
    displayScope = scope
    scheduler.cancel("list"); setError(false); setSelectionError(undefined); setFresh(new Set<string>()); setRecovery(new Set<string>()); setLoading(false)
    if (owner.active) untrack(() => void read())
  })
  let previousDemand: string | undefined
  createEffect(() => { props.selected(); selectionEpoch++; setSelectionError(undefined) })
  createEffect(() => {
    const demand = JSON.stringify([props.refresh(), props.selected()])
    if (previousDemand !== undefined && previousDemand !== demand) untrack(() => schedule())
    previousDemand = demand
  })
  const event = serverEvents.on("instance.event", value => {
    if (value.type !== "instance.event" || value.instanceId !== props.instanceId()) return
    if (value.event.type.startsWith("rpc.codenomad.missions.") || value.event.type === "plugin.updated") schedule()
    // Activity matters only while a schedule runs a passage, or after a failed read.
    else if (isMissionActivityEvent(value.event) && (error() || rows().some(doc => doc.pendingPassage))) schedule("activity")
  })
  const reconnect = serverEvents.on("instance.eventStatus", value => {
    if (value.type === "instance.eventStatus" && value.instanceId === props.instanceId() && value.status === "connected") schedule()
  })
  const opened = serverEvents.forInstance(props.instanceId).onOpen(() => schedule())
  onCleanup(() => { epoch++; controller?.abort(); scheduler.cancel("list"); event(); reconnect(); opened() })
  return { rows, error, selectionError, fresh: (id: string) => fresh().has(id),
    recoveryEligible: (id: string) => fresh().has(id) || recovery().has(id), loading, next, refresh: () => schedule(),
    more: () => { if (next() && !loading()) void read(true) } }
}
