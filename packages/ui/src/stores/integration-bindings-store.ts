import { createSignal } from "solid-js"
import type { IntegrationBindingResponse } from "../../../server/src/integration-types"
import { INTEGRATION_EVENT_COALESCE_MS, isIntegrationRefreshEvent } from "./integrations-store"

export interface IntegrationBindingTarget { instanceId: string; directory: string; sessionID: string; integrationId: string }
const UNKNOWN: IntegrationBindingResponse = { state: "unknown" }
const key = (target: IntegrationBindingTarget) => JSON.stringify([target.instanceId, target.directory, target.sessionID, target.integrationId])
interface Entry {
  target: IntegrationBindingTarget
  demand: number
  generation: number
  timer?: unknown
  reading?: { controller: AbortController; promise: Promise<void>; dirty: boolean }
}

/** Live authority exists only while the exact conversation/Location is demanded. Invalidations revoke it immediately. */
export function createIntegrationBindingsStore(
  read: (target: IntegrationBindingTarget, signal: AbortSignal) => Promise<IntegrationBindingResponse>,
  clock: { setTimer?: (callback: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void } = {},
) {
  const setTimer = clock.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = clock.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const entries = new Map<string, Entry>()
  const disconnected = new Set<string>()
  let transportConnected = true
  const connected = (entry: Entry) => transportConnected && !disconnected.has(entry.target.instanceId)
  const [snapshots, setSnapshots] = createSignal<ReadonlyMap<string, IntegrationBindingResponse>>(new Map())
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set())
  const publish = (id: string, value: IntegrationBindingResponse) => setSnapshots(current => new Map(current).set(id, value))
  const invalidate = (id: string, entry: Entry) => { entry.generation++; publish(id, UNKNOWN) }
  const refresh = (id: string, entry: Entry): Promise<void> => {
    if (!connected(entry)) return Promise.resolve()
    if (entry.reading) { entry.reading.dirty = true; return entry.reading.promise }
    const reading = { controller: new AbortController(), dirty: false, promise: Promise.resolve() }
    entry.reading = reading
    reading.promise = (async () => {
      try {
        do {
          reading.dirty = false
          const generation = entry.generation
          const answer = await read(entry.target, reading.controller.signal).catch(() => UNKNOWN)
          if (reading.controller.signal.aborted || entries.get(id) !== entry) return
          if (generation === entry.generation) publish(id, answer)
        } while (reading.dirty && entries.get(id) === entry)
      } finally { if (entry.reading === reading) entry.reading = undefined }
    })()
    return reading.promise
  }
  const cancelTimer = (entry: Entry) => {
    if (entry.timer !== undefined) clearTimer(entry.timer)
    entry.timer = undefined
  }
  const reconcile = (id: string, entry: Entry, immediate: boolean) => {
    invalidate(id, entry)
    if (!connected(entry)) return
    if (immediate) { cancelTimer(entry); return refresh(id, entry) }
    if (entry.timer !== undefined) return
    entry.timer = setTimer(() => { entry.timer = undefined; void refresh(id, entry) }, INTEGRATION_EVENT_COALESCE_MS)
  }
  return {
    state(target: IntegrationBindingTarget): IntegrationBindingResponse { return snapshots().get(key(target)) ?? UNKNOWN },
    busy(target: IntegrationBindingTarget): boolean { return busy().has(key(target)) },
    demand(target: IntegrationBindingTarget): () => void {
      const id = key(target)
      let entry = entries.get(id)
      if (!entry) {
        entries.set(id, entry = { target: { ...target }, demand: 0, generation: 0 })
        void refresh(id, entry)
      }
      const tracked = entry
      tracked.demand++
      let released = false
      return () => {
        if (released) return
        released = true
        if (--tracked.demand > 0 || entries.get(id) !== tracked) return
        cancelTimer(tracked); tracked.reading?.controller.abort(); entries.delete(id)
        setSnapshots(current => { const next = new Map(current); next.delete(id); return next })
      }
    },
    /** Payload-free integration events and exact-session changes are invalidation hints only. */
    applyEvent(instanceId: string, type: string, sessionID?: string): void {
      const integrationEvent = isIntegrationRefreshEvent(type)
      if (!integrationEvent && !["session.updated", "session.moved", "session.deleted"].includes(type)) return
      for (const [id, entry] of entries) {
        if (entry.target.instanceId !== instanceId || (!integrationEvent && entry.target.sessionID !== sessionID)) continue
        reconcile(id, entry, false)
      }
    },
    reconnect(instanceId?: string, isConnected = true): void {
      if (instanceId === undefined) transportConnected = isConnected
      else if (isConnected) disconnected.delete(instanceId)
      else disconnected.add(instanceId)
      for (const [id, entry] of entries) {
        if (instanceId !== undefined && entry.target.instanceId !== instanceId) continue
        if (connected(entry)) void reconcile(id, entry, true)
        else {
          cancelTimer(entry); invalidate(id, entry)
          entry.reading?.controller.abort()
          entry.reading = undefined
        }
      }
    },
    clearInstance(instanceId: string): void {
      disconnected.delete(instanceId)
      for (const [id, entry] of entries) {
        if (entry.target.instanceId !== instanceId) continue
        cancelTimer(entry); entry.reading?.controller.abort(); entries.delete(id)
        setSnapshots(current => { const next = new Map(current); next.delete(id); return next })
      }
    },
    /** An admitted mutation runs once; uncertain outcomes also reconcile its captured target, if still shown. */
    async run(target: IntegrationBindingTarget, mutation: () => Promise<void>): Promise<void> {
      const id = key(target)
      if (busy().has(id)) return
      setBusy(current => new Set(current).add(id))
      const entry = entries.get(id)
      if (entry) invalidate(id, entry)
      try { await mutation() }
      finally {
        setBusy(current => { const next = new Set(current); next.delete(id); return next })
        const current = entries.get(id)
        if (current) void reconcile(id, current, true)
      }
    },
  }
}
