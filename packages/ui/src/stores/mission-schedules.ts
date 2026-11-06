import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import type { MissionScheduleRead } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { partialMissionScheduleReceipt } from "../lib/mission-schedule-receipt"
import { createEventRefreshScheduler } from "../lib/event-refresh-scheduler"
import { backendEvents as serverEvents } from "../lib/server-events"
import { instances } from "./instances"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { sessionListRestored } from "./session-list-restoration"
import { isMissionActivityEvent } from "./missions"

export type UnifiedMissionSchedule = NonNullable<MissionScheduleRead["document"]>
export type UnifiedScheduleAction = Parameters<typeof serverApi.controlMissionSchedule>[2]["action"]
export type UnifiedScheduleHold = { phase: "control" | "activation" | "publication"; requestID: string; expectedRevision: number;
  action: UnifiedScheduleAction; partial: boolean; document: UnifiedMissionSchedule; original?: UnifiedScheduleHold; minimumRevision?: number }
export const unifiedScheduleHolds = new Map<string, UnifiedScheduleHold>()
const [holdVersion, setHoldVersion] = createSignal(0)
export const changedUnifiedScheduleHolds = () => setHoldVersion(value => value + 1)
export function unifiedScheduleHold(key: string) { holdVersion(); return unifiedScheduleHolds.get(key) }

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
  const read = async (parent = captureBackendOperation(props.instanceId()).signal) => {
    if (parent.aborted) return
    const owner = binding()
    if (!owner.active || !owner.project) return
    if (controller) { trailing = true; return }
    const captured = epoch, abort = controller = new AbortController()
    const signal = AbortSignal.any([abort.signal, parent])
    const current = () => captured === epoch && binding() === owner && !signal.aborted
    setLoading(true)
    try {
      const collected = new Map<string, UnifiedMissionSchedule>()
      let after: string | undefined
      for (let page = 0; page < pages; page++) {
        const value = await serverApi.fetchMissionSchedules(owner.instance, { directory: owner.directory, after, limit: 8 }, signal)
        if (!current()) return
        if (value.projectID !== owner.project || value.version !== 1 || value.next && value.next === after) throw new Error("Foreign schedule page")
        for (const row of value.schedules) collected.set(row.id, row)
        after = value.next
        if (!after) break
      }
      const selected = props.selected(), selectedEpoch = selectionEpoch
      const selectedCurrent = () => current() && selectedEpoch === selectionEpoch && props.selected() === selected
      const previous = snapshot().find(row => row.id === selected && !collected.has(row.id))
      // Inventory and its cursor are valid independently of the selected read.
      // Keep the selected display/pointer target while its revalidation runs.
      setRows([...collected.values(), ...(previous ? [previous] : [])]); setNext(after)
      setFresh(new Set([...collected.keys(), ...(previous && fresh().has(previous.id) ? [previous.id] : [])])); setError(false)
      published(owner, [...collected.values()])
      if (selected && !collected.has(selected)) {
        try {
          const value = await serverApi.fetchMissionSchedule(owner.instance, selected, { directory: owner.directory }, signal)
          if (!selectedCurrent()) return
          if (value.document && value.document.id !== selected) throw new Error("Foreign selected schedule")
          if (value.document) collected.set(selected, value.document)
          setRows([...collected.values()])
          setSelectionError(value.pending ? "pending" : undefined)
          setFresh(previous => new Set([...previous].filter(id => id !== selected).concat(!value.pending && value.document ? [selected] : [])))
          if (!value.pending && value.document) published(owner, [value.document])
        } catch (error) {
          if (!selectedCurrent()) return
          const receipt = partialMissionScheduleReceipt(error)
          setFresh(previous => new Set([...previous].filter(id => id !== selected)))
          setSelectionError(receipt?.document?.id === selected ? "pending" : "failed")
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
  const scheduler = createEventRefreshScheduler((_key, signal) => read(signal))
  const schedule = (urgency: "urgent" | "activity" = "urgent") => scheduler.schedule("list", urgency, captureBackendOperation(props.instanceId()).signal)
  let displayScope: string | undefined
  createEffect(() => {
    const owner = binding()
    epoch++; controller?.abort(); controller = undefined; trailing = false
    const scope = JSON.stringify([owner.instance, owner.project, owner.directory])
    if (scope !== displayScope) { setRows([]); setNext(undefined); pages = 1 }
    displayScope = scope
    scheduler.cancel("list"); setError(false); setSelectionError(undefined); setFresh(new Set<string>()); setLoading(false)
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
    else if (isMissionActivityEvent(value.event)) schedule("activity")
  })
  const reconnect = serverEvents.on("instance.eventStatus", value => {
    if (value.type === "instance.eventStatus" && value.instanceId === props.instanceId() && value.status === "connected") schedule()
  })
  const opened = serverEvents.forInstance(props.instanceId).onOpen(() => schedule())
  onCleanup(() => { epoch++; controller?.abort(); scheduler.cancel("list"); event(); reconnect(); opened() })
  return { rows, error, selectionError, fresh: (id: string) => fresh().has(id), loading, next, refresh: () => schedule(),
    more: () => { if (next() && !loading()) { pages++; schedule() } } }
}
