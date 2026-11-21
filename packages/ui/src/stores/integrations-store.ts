import { createSignal, untrack } from "solid-js"
import { parseInstanceKey } from "../lib/backend-identity"
import type { IntegrationsResponse } from "../../../server/src/integration-types"

/** Native events after which shown integrations are read again: integration RPC events, plugin and configuration changes. */
const INTEGRATION_EVENT = /^rpc\.neuralnomads\.[a-z][a-z0-9-]{0,31}\.(?:status_changed|hosts_changed)$/
const REFRESH_EVENTS = new Set(["plugin.updated", "config.updated"])
/** Events of one instance closer than this produce one read. */
export const INTEGRATION_EVENT_COALESCE_MS = 300

export function isIntegrationRefreshEvent(type: string): boolean {
  return INTEGRATION_EVENT.test(type) || REFRESH_EVENTS.has(type)
}

/** A Location's integrations as last read: `loading` until the first answer; a failed read keeps the last one shown. */
export type IntegrationsSnapshot = { status: "loading" } | { status: "error" } | { status: "ready"; response: IntegrationsResponse; stale?: boolean; refreshError?: boolean }

const LOADING: IntegrationsSnapshot = { status: "loading" }

interface Entry {
  instanceId: string
  directory: string
  demand: number
  generation: number
  authority?: AbortSignal
  releaseAuthority?: () => void
  reading?: { dirty: boolean; controller: AbortController; promise: Promise<void> }
}

/**
 * Integrations of the Locations a surface shows, keyed by instance and directory. Demand reads; integration RPC
 * events (`rpc.neuralnomads.<app>.status_changed` / `hosts_changed`), `plugin.updated` and `config.updated` of an
 * instance are coalesced over 300 ms into one read per demanded Location, with at most one trailing follow-up while a
 * read runs. Releasing the last demand aborts its read. Nothing reads on a timer: without events or demand, no
 * request (hence no integration RPC) is sent.
 */
export function createIntegrationsStore(
  read: (instanceId: string, directory: string, signal: AbortSignal) => Promise<IntegrationsResponse>,
  clock: { setTimer?: (callback: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void;
    signal?: (instanceId: string) => AbortSignal | undefined } = {},
) {
  const setTimer = clock.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = clock.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const [snapshots, setSnapshots] = createSignal<ReadonlyMap<string, IntegrationsSnapshot>>(new Map())
  const entries = new Map<string, Entry>()
  const disconnected = new Set<string>()
  const disconnectedBackends = new Set<string>()
  const timers = new Map<string, unknown>()
  const timerAuthorities = new Map<string, AbortSignal | undefined>()
  const key = (instanceId: string, directory: string) => `${instanceId}\0${directory}`
  const publish = (stateKey: string, snapshot: IntegrationsSnapshot) => setSnapshots(current => new Map(current).set(stateKey, snapshot))
  const cancelTimer = (instanceId: string) => {
    const timer = timers.get(instanceId)
    timers.delete(instanceId); timerAuthorities.delete(instanceId)
    if (timer !== undefined) clearTimer(timer)
  }
  const bind = (stateKey: string, entry: Entry) => {
    const authority = clock.signal?.(entry.instanceId)
    if (entry.authority === authority && entry.releaseAuthority) return authority
    entry.releaseAuthority?.()
    const old = entry.reading
    entry.reading = undefined
    entry.authority = authority
    old?.controller.abort()
    const abort = () => {
      if (entry.authority !== authority || entries.get(stateKey) !== entry) return
      entry.generation++
      const reading = entry.reading
      entry.reading = undefined
      if (timerAuthorities.get(entry.instanceId) === authority) cancelTimer(entry.instanceId)
      reading?.controller.abort()
      const previous = snapshots().get(stateKey)
      if (entry.authority === authority && previous?.status === "ready") publish(stateKey, { ...previous, stale: true })
    }
    authority?.addEventListener("abort", abort, { once: true })
    entry.releaseAuthority = () => { authority?.removeEventListener("abort", abort); entry.releaseAuthority = undefined }
    return authority
  }

  const refreshEntry = (stateKey: string, entry: Entry): Promise<void> => {
    if (entry.demand === 0) return Promise.resolve()
    const authority = bind(stateKey, entry)
    if (authority?.aborted || disconnected.has(entry.instanceId) || disconnectedBackends.has(parseInstanceKey(entry.instanceId).backendId)) return Promise.resolve()
    if (entry.reading) {
      entry.reading.dirty = true
      return entry.reading.promise
    }
    const reading = { dirty: false, controller: new AbortController(), promise: Promise.resolve() }
    const signal = authority ? AbortSignal.any([authority, reading.controller.signal]) : reading.controller.signal
    entry.reading = reading
    reading.promise = (async () => {
      try {
        do {
          reading.dirty = false
          const generation = entry.generation
          if (signal.aborted) return
          const answer = await read(entry.instanceId, entry.directory, signal).then(
            (response): IntegrationsSnapshot => ({ status: "ready", response }), (): IntegrationsSnapshot => ({ status: "error" }))
          if (signal.aborted || entries.get(stateKey) !== entry) return
          if (generation !== entry.generation) continue
          const previous = snapshots().get(stateKey)
          publish(stateKey, answer.status === "error" && previous?.status === "ready" ? { ...previous, stale: true, refreshError: true } : answer)
        } while (reading.dirty && entry.demand > 0 && entries.get(stateKey) === entry)
      } finally {
        if (entry.reading === reading) entry.reading = undefined
      }
    })()
    return reading.promise
  }

  const refreshDemanded = (instanceId?: string, backendId?: string): Promise<void> => Promise.all([...entries].map(([stateKey, entry]) =>
    (instanceId === undefined || entry.instanceId === instanceId) && (backendId === undefined || parseInstanceKey(entry.instanceId).backendId === backendId)
      ? refreshEntry(stateKey, entry) : undefined)).then(() => undefined)

  const invalidate = (instanceId?: string, backendId?: string): void => {
    for (const [stateKey, entry] of entries) {
      if (instanceId !== undefined && entry.instanceId !== instanceId) continue
      if (backendId !== undefined && parseInstanceKey(entry.instanceId).backendId !== backendId) continue
      entry.generation++
      const previous = snapshots().get(stateKey)
      if (previous?.status === "ready") publish(stateKey, { ...previous, stale: true })
    }
  }

  return {
    state(instanceId: string, directory: string): IntegrationsSnapshot {
      return snapshots().get(key(instanceId, directory)) ?? LOADING
    },
    /** Reads now and follows the Location's events until the returned release. */
    demand(instanceId: string, directory: string): () => void {
      const stateKey = key(instanceId, directory)
      let entry = entries.get(stateKey)
      if (!entry) entries.set(stateKey, entry = { instanceId, directory, demand: 0, generation: 0 })
      const tracked = entry
      tracked.demand += 1
      if (tracked.demand === 1) {
        const previous = untrack(() => snapshots().get(stateKey))
        if (previous?.status === "ready") publish(stateKey, { ...previous, stale: true })
        void refreshEntry(stateKey, tracked)
      }
      let released = false
      return () => {
        if (released) return
        released = true
        tracked.demand -= 1
        if (tracked.demand > 0) return
        if (entries.get(stateKey) === tracked) entries.delete(stateKey)
        const reading = tracked.reading
        tracked.releaseAuthority?.()
        tracked.reading = undefined
        reading?.controller.abort()
        if (![...entries.values()].some(value => value.instanceId === instanceId && value.demand)) cancelTimer(instanceId)
      }
    },
    refreshDemanded,
    invalidate,
    connection(instanceId: string | undefined, connected: boolean, backendId?: string): void {
      const flags = instanceId === undefined ? disconnectedBackends : disconnected
      const id = instanceId ?? backendId!
      if (connected) { flags.delete(id); return }
      flags.add(id)
      invalidate(instanceId, backendId)
      for (const entry of entries.values()) {
        if (instanceId !== undefined ? entry.instanceId !== instanceId : parseInstanceKey(entry.instanceId).backendId !== backendId) continue
        cancelTimer(entry.instanceId)
        const reading = entry.reading
        entry.reading = undefined
        reading?.controller.abort()
      }
    },
    /** A native event of `instanceId`: schedules one coalesced read of its demanded Locations when it may change them. */
    applyEvent(instanceId: string, type: string): void {
      const authority = clock.signal?.(instanceId)
      if (authority?.aborted) return
      if (!isIntegrationRefreshEvent(type)) return
      invalidate(instanceId)
      if (timers.has(instanceId)) return
      if (![...entries.values()].some(entry => entry.instanceId === instanceId)) return
      timers.set(instanceId, setTimer(() => {
        if (authority?.aborted || timerAuthorities.get(instanceId) !== authority) return
        timers.delete(instanceId); timerAuthorities.delete(instanceId)
        void refreshDemanded(instanceId)
      }, INTEGRATION_EVENT_COALESCE_MS))
      timerAuthorities.set(instanceId, authority)
    },
    clearInstance(instanceId: string): void {
      disconnected.delete(instanceId)
      cancelTimer(instanceId)
      for (const [stateKey, entry] of [...entries]) {
        if (entry.instanceId !== instanceId) continue
        entries.delete(stateKey)
        entry.releaseAuthority?.()
        entry.reading?.controller.abort()
      }
      setSnapshots(current => new Map([...current].filter(([stateKey]) => !stateKey.startsWith(`${instanceId}\0`))))
    },
  }
}

export type IntegrationsStore = ReturnType<typeof createIntegrationsStore>
