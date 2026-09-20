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
  error?: unknown
}

interface CacheRecord {
  readonly key: string
  readonly instanceId: string
  readonly location: PluginControlLocation
  generation: number
  snapshot?: PluginControlsSnapshot
  loading: boolean
  refreshing: boolean
  error?: unknown
  inFlight?: Promise<void>
  trailing: boolean
}

interface PluginControlsApi {
  getPluginControls(instanceId: string, location: PluginControlLocation, signal?: AbortSignal): Promise<PluginControlsSnapshot>
  setPluginActivation(instanceId: string, payload: PluginActivationMutationRequest): Promise<PluginActivationMutationResponse>
}

const EMPTY_STATE: PluginControlsState = { loading: false, refreshing: false }

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
    if (record.snapshot && !options?.force) return Promise.resolve()
    return this.loadRecord(record, Boolean(options?.force))
  }

  async mutate(
    instanceId: string,
    location: PluginControlLocation,
    pluginId: string,
    scope: PluginControlScope,
    enabled: boolean,
  ): Promise<PluginActivationMutationResponse> {
    const record = this.record(instanceId, location)
    try {
      const response = await this.api.setPluginActivation(instanceId, { location, pluginId, scope, enabled })
      if (this.records.get(record.key) !== record) return response
      // Fence any passive read that started before the mutation became durable.
      record.generation += 1
      record.snapshot = response.snapshot
      record.error = undefined
      record.loading = false
      record.refreshing = false
      if (record.inFlight) record.trailing = true
      this.publish(record)
      return response
    } catch (error) {
      // The caller presents mutation failures. Keep this field reserved for
      // passive read failures so a save error is not mislabeled as stale data.
      throw error
    }
  }

  invalidateInstance(instanceId: string): void {
    for (const record of this.records.values()) {
      if (record.instanceId !== instanceId) continue
      record.generation += 1
      if (record.inFlight) {
        record.trailing = true
        record.refreshing = Boolean(record.snapshot)
        this.publish(record)
      } else {
        void this.loadRecord(record, true)
      }
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
    if (existing) return existing
    const record: CacheRecord = {
      key,
      instanceId,
      location: { ...location },
      generation: 0,
      loading: false,
      refreshing: false,
      trailing: false,
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
        this.publish(record)
        if (trailing) void this.loadRecord(record, true)
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
  return `${JSON.stringify(instanceId)}:${JSON.stringify([location.directory, location.workspaceID])}`
}
