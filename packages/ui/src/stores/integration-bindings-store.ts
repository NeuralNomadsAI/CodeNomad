import { createSignal } from "solid-js"
import { parseInstanceKey, LOCAL_BACKEND_ID } from "../lib/backend-identity"
import type { IntegrationBindingResponse } from "../../../server/src/integration-types"
import { INTEGRATION_EVENT_COALESCE_MS, isIntegrationRefreshEvent } from "./integrations-store"

export interface IntegrationBindingTarget { instanceId: string; directory: string; sessionID: string; integrationId: string }
const UNKNOWN: IntegrationBindingResponse = { state: "unknown" }
const key = (target: IntegrationBindingTarget) => JSON.stringify([target.instanceId, target.directory, target.sessionID, target.integrationId])
interface Entry {
  target: IntegrationBindingTarget
  demand: number
  generation: number
  signal?: AbortSignal
  releaseAuthority?: () => void
  timer?: unknown
  reading?: { controller: AbortController; promise: Promise<void>; dirty: boolean }
}

/** Live authority exists only while the exact conversation/Location is demanded. Invalidations revoke it immediately. */
export function createIntegrationBindingsStore(
  read: (target: IntegrationBindingTarget, signal: AbortSignal) => Promise<IntegrationBindingResponse>,
  clock: { setTimer?: (callback: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void;
    signal?: (target: IntegrationBindingTarget) => AbortSignal | undefined } = {},
) {
  const setTimer = clock.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = clock.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const entries = new Map<string, Entry>()
  const disconnected = new Set<string>()
  const disconnectedBackends = new Set<string>()
  const connected = (entry: Entry) => !entry.signal?.aborted && !disconnectedBackends.has(parseInstanceKey(entry.target.instanceId).backendId) && !disconnected.has(entry.target.instanceId)
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
  const drop = (id: string, entry: Entry) => {
    if (entries.get(id) !== entry) return
    entries.delete(id)
    cancelTimer(entry)
    entry.releaseAuthority?.()
    entry.reading?.controller.abort()
    // Aborting IO can synchronously acquire a replacement under the same key.
    if (!entries.has(id)) setSnapshots(current => { const next = new Map(current); next.delete(id); return next })
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
      const signal = clock.signal?.(target)
      if (signal?.aborted) return () => {}
      let entry = entries.get(id)
      if (entry && entry.signal !== signal) { drop(id, entry); entry = entries.get(id) }
      if (signal?.aborted) return () => {}
      if (!entry) {
        entries.set(id, entry = { target: { ...target }, demand: 0, generation: 0, signal })
        const owned = entry
        const abort = () => drop(id, owned)
        signal?.addEventListener("abort", abort, { once: true })
        entry.releaseAuthority = () => signal?.removeEventListener("abort", abort)
        if (signal?.aborted) abort()
        void refresh(id, entry)
      }
      const tracked = entry
      tracked.demand++
      let released = false
      return () => {
        if (released) return
        released = true
        if (--tracked.demand > 0 || entries.get(id) !== tracked) return
        drop(id, tracked)
      }
    },
    /** An explicit new authoritative read of one demanded target; its previous answer is revoked first. */
    refresh(target: IntegrationBindingTarget): Promise<void> {
      const id = key(target)
      const entry = entries.get(id)
      return entry ? reconcile(id, entry, true) ?? Promise.resolve() : Promise.resolve()
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
    reconnect(instanceId?: string, isConnected = true, backendId = LOCAL_BACKEND_ID): void {
      if (instanceId === undefined) {
        if (isConnected) disconnectedBackends.delete(backendId)
        else disconnectedBackends.add(backendId)
      }
      else if (isConnected) disconnected.delete(instanceId)
      else disconnected.add(instanceId)
      for (const [id, entry] of entries) {
        if (instanceId !== undefined && entry.target.instanceId !== instanceId) continue
        if (instanceId === undefined && parseInstanceKey(entry.target.instanceId).backendId !== backendId) continue
        if (connected(entry)) void reconcile(id, entry, true)
        else {
          cancelTimer(entry); invalidate(id, entry)
          entry.reading?.controller.abort()
          entry.reading = undefined
        }
      }
    },
    clearInstance(instanceId: string, signal?: AbortSignal): void {
      disconnected.delete(instanceId)
      for (const [id, entry] of entries) {
        if (entry.target.instanceId !== instanceId) continue
        if (signal && entry.signal !== signal) continue
        drop(id, entry)
      }
    },
    clearBackend(backendId: string, signal?: AbortSignal): void {
      disconnectedBackends.delete(backendId)
      for (const instanceId of disconnected) {
        if (parseInstanceKey(instanceId).backendId === backendId) disconnected.delete(instanceId)
      }
      for (const instanceId of new Set([...entries.values()].map(entry => entry.target.instanceId))) {
        if (parseInstanceKey(instanceId).backendId === backendId) this.clearInstance(instanceId, signal)
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
        if (current && current === entry && !current.signal?.aborted) void reconcile(id, current, true)
      }
    },
  }
}
