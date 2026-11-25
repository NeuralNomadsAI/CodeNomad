import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import type { MissionScheduleRead } from "../../../server/src/api-types"
import type { ServerApi } from "../lib/api-client"
import { backendOf } from "../lib/backend-client"
import { parseInstanceKey } from "../lib/backend-identity"
import { captureBackendOperation } from "../lib/backend-operation"
import { partialMissionScheduleReceipt } from "../lib/mission-schedule-receipt"
import { createEventRefreshScheduler } from "../lib/event-refresh-scheduler"
import { backendEvents as serverEvents } from "../lib/server-events"
import { instances } from "./instances"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { sessionListRestored } from "./session-list-restoration"
import { isMissionActivityEvent } from "./missions"

export type UnifiedMissionSchedule = NonNullable<MissionScheduleRead["document"]>
export type UnifiedScheduleAction = Parameters<ServerApi["controlMissionSchedule"]>[2]["action"]
export type UnifiedScheduleHold = { phase: "control" | "activation" | "publication"; requestID: string; expectedRevision: number;
  action: UnifiedScheduleAction; partial: boolean; document: UnifiedMissionSchedule; minimumRevision?: number }
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
  const [listLoading, setListLoading] = createSignal(false), [selectionLoading, setSelectionLoading] = createSignal(false)
  const loading = () => listLoading() || selectionLoading()
  const [next, setNext] = createSignal<string>()
  let controller: AbortController | undefined, selectionController: AbortController | undefined
  let activeRead: Promise<void> | undefined, readingPages = false, inventoryLoaded = false
  let epoch = 0, selectionEpoch = 0, pages = 1, trailing = false
  let pageRows = new Map<string, UnifiedMissionSchedule>(), selectedRow: UnifiedMissionSchedule | undefined
  const publishSnapshot = () => setRows([
    ...pageRows.values(),
    ...(selectedRow && !pageRows.has(selectedRow.id) ? [selectedRow] : []),
  ])
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
  const readSelected = async (selected: string, parent = captureBackendOperation(props.instanceId()).signal) => {
    if (parent.aborted) return
    const owner = binding()
    if (!owner.active || !owner.project) return
    selectionController?.abort()
    const captured = epoch, selectedEpoch = selectionEpoch
    const abort = selectionController = new AbortController()
    const signal = AbortSignal.any([abort.signal, parent])
    const selectedCurrent = () => captured === epoch && binding() === owner && !signal.aborted
      && selectedEpoch === selectionEpoch && props.selected() === selected
    setSelectionLoading(true)
    try {
      const api = backendOf(owner.instance).api, workspaceId = parseInstanceKey(owner.instance).workspaceId
      const value = await api.fetchMissionSchedule(workspaceId, selected, { directory: owner.directory }, signal)
      if (!selectedCurrent()) return
      if (value.document && value.document.id !== selected) throw new Error("Foreign selected schedule")
      selectedRow = value.document ?? undefined
      publishSnapshot()
      setSelectionError(value.pending ? "pending" : undefined)
      setFresh(previous => new Set([...previous].filter(id => id !== selected).concat(!value.pending && value.document ? [selected] : [])))
      if (!value.pending && value.document) published(owner, [value.document])
    } catch (error) {
      if (!selectedCurrent()) return
      const receipt = partialMissionScheduleReceipt(error)
      setFresh(previous => new Set([...previous].filter(id => id !== selected)))
      setSelectionError(receipt?.document?.id === selected ? "pending" : "failed")
    } finally {
      if (selectionController === abort) { selectionController = undefined; setSelectionLoading(false) }
    }
  }
  const read = (append = false, parent = captureBackendOperation(props.instanceId()).signal): Promise<void> => {
    if (parent.aborted) return Promise.resolve()
    const owner = binding()
    if (!owner.active || !owner.project) return Promise.resolve()
    if (controller) { trailing = true; return activeRead ?? Promise.resolve() }
    const captured = epoch, abort = controller = new AbortController()
    const signal = AbortSignal.any([abort.signal, parent])
    const current = () => captured === epoch && binding() === owner && !signal.aborted
    setListLoading(true)
    readingPages = true
    const run = (async () => {
      try {
        const api = backendOf(owner.instance).api, workspaceId = parseInstanceKey(owner.instance).workspaceId
        const collected = new Map<string, UnifiedMissionSchedule>()
        let after: string | undefined = append ? next() : undefined
        for (let page = 0; page < (append ? 1 : pages); page++) {
          const value = await api.fetchMissionSchedules(workspaceId, { directory: owner.directory, after, limit: 8 }, signal)
          if (!current()) return
          if (value.projectID !== owner.project || value.version !== 1 || value.next && value.next === after) throw new Error("Foreign schedule page")
          for (const row of value.schedules) collected.set(row.id, row)
          after = value.next
          if (!after) break
        }
        readingPages = false
        if (append) {
          pages++
          for (const [id, row] of collected) pageRows.set(id, row)
          if (selectedRow && pageRows.has(selectedRow.id)) selectedRow = undefined
          publishSnapshot()
          setNext(after); setFresh(previous => new Set([...previous, ...collected.keys()])); setError(false)
          published(owner, [...collected.values()])
          return
        }
        const selected = props.selected(), selectedEpoch = selectionEpoch
        const selectedCurrent = () => current() && selectedEpoch === selectionEpoch && props.selected() === selected
        const previous = selected && selectedRow?.id === selected && !collected.has(selected) ? selectedRow
          : snapshot().find(row => row.id === selected && !collected.has(row.id))
        pageRows = collected
        selectedRow = previous
        inventoryLoaded = true
        // Inventory and its cursor are valid independently of the selected read.
        // Keep the selected display/pointer target while its revalidation runs.
        publishSnapshot(); setNext(after)
        setFresh(new Set([...collected.keys(), ...(previous && fresh().has(previous.id) ? [previous.id] : [])])); setError(false)
        published(owner, [...collected.values()])
        if (selected && !collected.has(selected)) {
          await readSelected(selected, signal)
        } else if (selectedCurrent()) {
          setSelectionError(undefined)
        }
      } catch { if (current()) setError(true) }
      finally {
        if (controller === abort) {
          controller = undefined; readingPages = false; activeRead = undefined; setListLoading(false)
        }
        if (trailing && current()) { trailing = false; scheduler.schedule("list", "urgent", parent) }
      }
    })()
    activeRead = run
    return run
  }
  const scheduler = createEventRefreshScheduler((_key, signal) => read(false, signal))
  const schedule = (urgency: "urgent" | "activity" = "urgent") => scheduler.schedule("list", urgency, captureBackendOperation(props.instanceId()).signal)
  const refreshNow = async (parent = captureBackendOperation(props.instanceId()).signal): Promise<void> => {
    if (parent.aborted || !binding().active || !binding().project) return
    const captured = epoch
    scheduler.cancel("list")
    if (activeRead) {
      trailing = true
      await activeRead.catch(() => {})
      if (parent.aborted || captured !== epoch || !binding().active || !binding().project) return
      scheduler.cancel("list")
      if (activeRead) { await activeRead.catch(() => {}); return }
    }
    await read(false, parent)
  }
  let displayScope: string | undefined
  createEffect(() => {
    const owner = binding()
    epoch++; controller?.abort(); controller = undefined; activeRead = undefined; readingPages = false; trailing = false
    selectionController?.abort(); selectionController = undefined
    const scope = JSON.stringify([owner.instance, owner.project, owner.directory])
    if (scope !== displayScope) { pageRows = new Map(); selectedRow = undefined; inventoryLoaded = false; setRows([]); setNext(undefined); pages = 1 }
    displayScope = scope
    scheduler.cancel("list"); setError(false); setSelectionError(undefined); setFresh(new Set<string>()); setListLoading(false); setSelectionLoading(false)
    if (owner.active) untrack(() => void read())
  })
  let previousRefresh: number | undefined
  createEffect(() => {
    const value = props.refresh()
    if (previousRefresh !== undefined && previousRefresh !== value) untrack(() => schedule())
    previousRefresh = value
  })
  let selectedInitialized = false
  let previousSelected: string | undefined
  createEffect(() => {
    const selected = props.selected()
    selectionEpoch++
    selectionController?.abort(); selectionController = undefined; setSelectionLoading(false)
    setSelectionError(undefined)
    const changed = selectedInitialized && previousSelected !== selected
    selectedInitialized = true
    previousSelected = selected
    if (!changed || !selected) return
    untrack(() => {
      const owner = binding()
      if (!owner.active || !owner.project) return
      // Loaded selections come from the current snapshot; point-read only off-page or stale ones
      // once the schedule inventory has loaded cleanly.
      if (pageRows.has(selected) && fresh().has(selected)) return
      if (readingPages || error() || !inventoryLoaded) return
      void readSelected(selected)
    })
  })
  const event = serverEvents.on("instance.event", value => {
    if (value.type !== "instance.event" || value.instanceId !== props.instanceId()) return
    if (value.event.type.startsWith("rpc.codenomad.missions.") || value.event.type === "plugin.updated") schedule()
    else if (isMissionActivityEvent(value.event)) {
      // Schedule documents do not carry the passage's full actor roster (native passages
      // may also reuse independent roots), so keep events whenever any passage is pending.
      if (!snapshot().some(doc => doc.pendingPassage)) return
      schedule("activity")
    }
  })
  const reconnect = serverEvents.on("instance.eventStatus", value => {
    if (value.type === "instance.eventStatus" && value.instanceId === props.instanceId() && value.status === "connected") schedule()
  })
  const opened = serverEvents.forInstance(props.instanceId).onOpen(() => schedule())
  onCleanup(() => { epoch++; controller?.abort(); selectionController?.abort(); scheduler.cancel("list"); event(); reconnect(); opened() })
  return { rows, error, selectionError, fresh: (id: string) => fresh().has(id), loading, next, refresh: () => schedule(), refreshNow,
    more: () => { if (next() && !loading()) void read(true) } }
}
