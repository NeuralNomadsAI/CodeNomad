import { createSignal, untrack } from "solid-js"
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
  clock: { setTimer?: (callback: () => void, ms: number) => unknown; clearTimer?: (timer: unknown) => void } = {},
) {
  const setTimer = clock.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = clock.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const [snapshots, setSnapshots] = createSignal<ReadonlyMap<string, IntegrationsSnapshot>>(new Map())
  const entries = new Map<string, Entry>()
  const timers = new Map<string, unknown>()
  const key = (instanceId: string, directory: string) => `${instanceId}\0${directory}`
  const publish = (stateKey: string, snapshot: IntegrationsSnapshot) => setSnapshots(current => new Map(current).set(stateKey, snapshot))

  const refreshEntry = (stateKey: string, entry: Entry): Promise<void> => {
    if (entry.demand === 0) return Promise.resolve()
    if (entry.reading) {
      entry.reading.dirty = true
      return entry.reading.promise
    }
    const reading = { dirty: false, controller: new AbortController(), promise: Promise.resolve() }
    entry.reading = reading
    reading.promise = (async () => {
      try {
        do {
          reading.dirty = false
          const generation = entry.generation
          const answer = await read(entry.instanceId, entry.directory, reading.controller.signal).then(
            (response): IntegrationsSnapshot => ({ status: "ready", response }), (): IntegrationsSnapshot => ({ status: "error" }))
          if (reading.controller.signal.aborted || entries.get(stateKey) !== entry) return
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

  const refreshDemanded = (instanceId?: string): Promise<void> => Promise.all([...entries].map(([stateKey, entry]) =>
    instanceId === undefined || entry.instanceId === instanceId ? refreshEntry(stateKey, entry) : undefined)).then(() => undefined)

  const invalidate = (instanceId?: string): void => {
    for (const [stateKey, entry] of entries) {
      if (instanceId !== undefined && entry.instanceId !== instanceId) continue
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
        tracked.reading?.controller.abort()
        tracked.reading = undefined
        if (entries.get(stateKey) === tracked) entries.delete(stateKey)
      }
    },
    refreshDemanded,
    invalidate,
    /** A native event of `instanceId`: schedules one coalesced read of its demanded Locations when it may change them. */
    applyEvent(instanceId: string, type: string): void {
      if (!isIntegrationRefreshEvent(type)) return
      invalidate(instanceId)
      if (timers.has(instanceId)) return
      if (![...entries.values()].some(entry => entry.instanceId === instanceId)) return
      timers.set(instanceId, setTimer(() => {
        timers.delete(instanceId)
        void refreshDemanded(instanceId)
      }, INTEGRATION_EVENT_COALESCE_MS))
    },
    clearInstance(instanceId: string): void {
      const timer = timers.get(instanceId)
      if (timer !== undefined) clearTimer(timer)
      timers.delete(instanceId)
      for (const [stateKey, entry] of [...entries]) {
        if (entry.instanceId !== instanceId) continue
        entry.reading?.controller.abort()
        entries.delete(stateKey)
      }
      setSnapshots(current => new Map([...current].filter(([stateKey]) => !stateKey.startsWith(`${instanceId}\0`))))
    },
  }
}

export type IntegrationsStore = ReturnType<typeof createIntegrationsStore>
