import { createSignal } from "solid-js"
import type {
  PluginActivationMutationRequest,
  PluginActivationMutationResponse,
  PluginControlLocation,
  PluginControlScope,
  PluginControlsSnapshot,
} from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"

export interface PluginControlsState {
  snapshot?: PluginControlsSnapshot
  loading: boolean
  refreshing: boolean
  stale: boolean
  error?: unknown
}

interface CacheRecord {
  readonly key: string
  readonly instanceId: string
  location: PluginControlLocation
  generation: number
  snapshot?: PluginControlsSnapshot
  loading: boolean
  refreshing: boolean
  stale: boolean
  error?: unknown
  inFlight?: Promise<void>
  trailing: boolean
  mutationTail: Promise<void>
}

interface PluginControlsApi {
  getPluginControls(instanceId: string, location: PluginControlLocation, signal?: AbortSignal): Promise<PluginControlsSnapshot>
  setPluginActivation(instanceId: string, payload: PluginActivationMutationRequest): Promise<PluginActivationMutationResponse>
}

const EMPTY_STATE: PluginControlsState = { loading: false, refreshing: false, stale: false }

export class PluginControlsCache {
  private readonly records = new Map<string, CacheRecord>()
  private readonly stateSignal = createSignal<Map<string, PluginControlsState>>(new Map())
  readonly states = this.stateSignal[0]
  private readonly setStates = this.stateSignal[1]

  constructor(private readonly api: PluginControlsApi) {}

  state(instanceId: string, location: PluginControlLocation): PluginControlsState {
    return this.states().get(cacheKey(instanceId, location)) ?? EMPTY_STATE
  }

  load(instanceId: string, location: PluginControlLocation, options?: { force?: boolean }): Promise<void> {
    const record = this.record(instanceId, location)
    if (record.snapshot && !record.stale && !options?.force) return Promise.resolve()
    return this.loadRecord(record, Boolean(options?.force || record.stale))
  }

  async mutate(
    instanceId: string,
    location: PluginControlLocation,
    pluginId: string,
    scope: PluginControlScope,
    enabled: boolean,
  ): Promise<PluginActivationMutationResponse> {
    const record = this.record(instanceId, location)
    const mutate = async () => {
      if (this.records.get(record.key) !== record) {
        throw new Error("Plugin control location is no longer active")
      }
      const response = await this.api.setPluginActivation(instanceId, { location, pluginId, scope, enabled })
      if (this.records.get(record.key) !== record) return response
      // Fence any passive read that started before the mutation became durable.
      record.generation += 1
      record.snapshot = response.snapshot
      record.error = undefined
      record.loading = false
      record.refreshing = false
      record.stale = false
      if (record.inFlight) record.trailing = true
      this.publish(record)
      if (scope === "global") this.invalidateSiblingLocations(record)
      return response
    }
    const result = record.mutationTail.then(mutate, mutate)
    // Keep writes for one location ordered even when an earlier write fails.
    // The caller presents mutation failures; passive read errors remain separate.
    record.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  invalidateInstance(instanceId: string): void {
    this.invalidate(instanceId)
  }

  invalidateLocation(instanceId: string, location: PluginControlLocation): void {
    this.invalidate(instanceId, location)
  }

  private invalidate(instanceId: string, location?: PluginControlLocation): void {
    const locationKey = location ? cacheKey(instanceId, location) : undefined
    for (const record of this.records.values()) {
      if (record.instanceId !== instanceId || (locationKey && record.key !== locationKey)) continue
      record.generation += 1
      record.stale = true
      this.publish(record)
    }
  }

  private invalidateSiblingLocations(current: CacheRecord): void {
    for (const record of this.records.values()) {
      if (record === current || record.instanceId !== current.instanceId) continue
      record.generation += 1
      record.stale = true
      this.publish(record)
    }
  }

  clearInstance(instanceId: string): void {
    let changed = false
    for (const [key, record] of this.records) {
      if (record.instanceId !== instanceId) continue
      record.generation += 1
      this.records.delete(key)
      changed = true
    }
    if (!changed) return
    this.setStates((previous) => {
      const next = new Map(previous)
      for (const key of next.keys()) {
        if (key.startsWith(`${JSON.stringify(instanceId)}:`)) next.delete(key)
      }
      return next
    })
  }

  private record(instanceId: string, location: PluginControlLocation): CacheRecord {
    const key = cacheKey(instanceId, location)
    const existing = this.records.get(key)
    if (existing) {
      existing.location = { ...location }
      return existing
    }
    const record: CacheRecord = {
      key,
      instanceId,
      location: { ...location },
      generation: 0,
      loading: false,
      refreshing: false,
      stale: false,
      trailing: false,
      mutationTail: Promise.resolve(),
    }
    this.records.set(key, record)
    return record
  }

  private loadRecord(record: CacheRecord, force: boolean): Promise<void> {
    if (record.inFlight) {
      if (force) record.trailing = true
      return record.inFlight
    }
    const generation = record.generation
    record.stale = false
    record.loading = !record.snapshot
    record.refreshing = Boolean(record.snapshot)
    record.error = undefined
    this.publish(record)
    const promise = this.api.getPluginControls(record.instanceId, record.location)
      .then((snapshot) => {
        if (this.records.get(record.key) !== record || generation !== record.generation) return
        record.snapshot = snapshot
        record.error = undefined
      })
      .catch((error) => {
        if (this.records.get(record.key) !== record || generation !== record.generation) return
        record.error = error
      })
      .finally(() => {
        if (this.records.get(record.key) !== record || record.inFlight !== promise) return
        record.inFlight = undefined
        record.loading = false
        record.refreshing = false
        const trailing = record.trailing
        record.trailing = false
        if (trailing) {
          void this.loadRecord(record, true)
          return
        }
        this.publish(record)
      })
    record.inFlight = promise
    return promise
  }

  private publish(record: CacheRecord): void {
    if (this.records.get(record.key) !== record) return
    const state: PluginControlsState = {
      snapshot: record.snapshot,
      loading: record.loading,
      refreshing: record.refreshing,
      stale: record.stale,
      error: record.error,
    }
    this.setStates((previous) => {
      const next = new Map(previous)
      next.set(record.key, state)
      return next
    })
  }
}

export const pluginControlsCache = new PluginControlsCache(serverApi)

function cacheKey(instanceId: string, location: PluginControlLocation): string {
  return `${JSON.stringify(instanceId)}:${JSON.stringify(location.directory)}`
}
