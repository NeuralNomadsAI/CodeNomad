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
  readonly keys: Set<string>
  readonly demands: Set<{ record: CacheRecord }>
  readonly instanceId: string
  location: PluginControlLocation
  canonicalLocation: boolean
  generation: number
  invalidationRevision: number
  snapshotRevision: number
  snapshot?: PluginControlsSnapshot
  loading: boolean
  refreshing: boolean
  stale: boolean
  error?: unknown
  inFlight?: Promise<void>
  inFlightController?: AbortController
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
  private readonly pendingUnknownInvalidations = new Map<string, number>()
  private revision = 0
  private readonly stateSignal = createSignal<Map<string, PluginControlsState>>(new Map())
  readonly states = this.stateSignal[0]
  private readonly setStates = this.stateSignal[1]

  constructor(private readonly api: PluginControlsApi) {}

  state(instanceId: string, location: PluginControlLocation): PluginControlsState {
    return this.states().get(cacheKey(instanceId, location)) ?? EMPTY_STATE
  }

  /** Own visible refresh demand until deactivation/disposal; aliases share owners. */
  acquireDemand(instanceId: string, location: PluginControlLocation): () => void {
    const record = this.record(instanceId, location)
    const demand = { record }
    record.demands.add(demand)
    void this.load(instanceId, location, { force: Boolean(record.error) })
    return () => {
      // Canonical adoption can transfer the handle to a different record.
      const current = demand.record
      if (!current.demands.delete(demand) || current.demands.size > 0) return
      if (current.trailing) {
        current.trailing = false
        current.stale = true
        this.publish(current)
      }
    }
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
      if (!this.isActive(record)) {
        throw new Error("Plugin control location is no longer active")
      }
      const requestRevision = ++this.revision
      const response = await this.api.setPluginActivation(instanceId, {
        location: record.location,
        pluginId,
        scope,
        enabled,
      })
      if (!this.isActive(record) || !this.adoptCanonicalLocation(record, response.snapshot.location, true)) return response
      // Fence any passive read that started before the mutation became durable.
      record.generation += 1
      // A mutation overlays a durable rule onto inventory read BEFORE the write.
      // Events and completed reads during that write still require reconciliation;
      // in particular, do not roll newer runtime failures back to that inventory.
      const newerSnapshot = record.snapshot && record.snapshotRevision > requestRevision
        ? record.snapshot
        : undefined
      record.snapshot = newerSnapshot ? retainRuntime(response.snapshot, newerSnapshot) : response.snapshot
      // Alias reads dispatched during the write must also see this publication
      // as newer, even when the mutation's dispatch revision predates them.
      record.snapshotRevision = ++this.revision
      record.error = undefined
      record.loading = false
      record.refreshing = false
      record.stale = record.stale || record.invalidationRevision > requestRevision || Boolean(newerSnapshot)
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

  invalidateAll(): void {
    this.invalidateRecords([...new Set(this.records.values())])
  }

  invalidateLocation(instanceId: string, location: PluginControlLocation): void {
    this.invalidate(instanceId, location)
  }

  private invalidate(instanceId: string, location?: PluginControlLocation): void {
    if (!location) {
      const records = [...new Set(this.records.values())].filter((record) => record.instanceId === instanceId)
      this.invalidateRecords(records)
      return
    }
    const key = cacheKey(instanceId, location)
    const target = this.records.get(key)
    if (!target) {
      // Unknown directories match nothing immediately. Remember the canonical
      // key so a WSL alias learned later can still fence its first snapshot.
      this.pendingUnknownInvalidations.set(key, ++this.revision)
      while (this.pendingUnknownInvalidations.size > 200) {
        const oldest = this.pendingUnknownInvalidations.keys().next().value
        if (oldest === undefined) break
        this.pendingUnknownInvalidations.delete(oldest)
      }
      return
    }
    this.invalidateRecords([target])
  }

  private invalidateSiblingLocations(current: CacheRecord): void {
    const siblings = [...new Set(this.records.values())]
      .filter((record) => record !== current && record.instanceId === current.instanceId)
    this.invalidateRecords(siblings)
  }

  private invalidateRecords(records: readonly CacheRecord[]): void {
    for (const record of records) {
      record.generation += 1
      record.invalidationRevision = ++this.revision
      record.stale = true
    }
    this.publishAll(records)
  }

  clearInstance(instanceId: string): void {
    let changed = false
    for (const record of new Set(this.records.values())) {
      if (record.instanceId !== instanceId) continue
      record.generation += 1
      record.inFlightController?.abort()
      record.inFlightController = undefined
      record.demands.clear()
      for (const key of record.keys) {
        if (this.records.get(key) === record) this.records.delete(key)
      }
      changed = true
    }
    for (const key of this.pendingUnknownInvalidations.keys()) {
      if (key.startsWith(`${JSON.stringify(instanceId)}:`)) this.pendingUnknownInvalidations.delete(key)
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
      if (!existing.canonicalLocation) existing.location = { ...location }
      return existing
    }
    const record: CacheRecord = {
      keys: new Set([key]),
      demands: new Set(),
      instanceId,
      location: { ...location },
      canonicalLocation: false,
      generation: 0,
      invalidationRevision: 0,
      snapshotRevision: 0,
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
    const requestRevision = ++this.revision
    record.stale = false
    record.loading = !record.snapshot
    record.refreshing = Boolean(record.snapshot)
    record.error = undefined
    this.publish(record)
    const controller = new AbortController()
    record.inFlightController = controller
    const promise = this.api.getPluginControls(record.instanceId, record.location, controller.signal)
      .then((snapshot) => {
        if (!this.isActive(record) || generation !== record.generation) return
        if (!this.adoptCanonicalLocation(record, snapshot.location, false, { snapshot, revision: requestRevision })) return
        record.snapshot = snapshot
        record.snapshotRevision = ++this.revision
        record.error = undefined
      })
      .catch((error) => {
        if (!this.isActive(record) || generation !== record.generation) return
        // An aborted orphan fetch must not surface as a passive read error.
        if (controller.signal.aborted) return
        record.error = error
      })
      .finally(() => {
        if (!this.isActive(record) || record.inFlight !== promise) return
        record.inFlight = undefined
        if (record.inFlightController === controller) record.inFlightController = undefined
        record.loading = false
        record.refreshing = false
        const trailing = record.trailing
        record.trailing = false
        if (trailing) {
          // No follow-up may outlive its last visible owner. Keep the demand
          // as stale display state so reopening performs one reconciliation.
          record.stale = true
        }
        this.publish(record)
      })
    record.inFlight = promise
    return promise
  }

  private publish(record: CacheRecord): void {
    this.publishAll([record])
  }

  private publishAll(records: readonly CacheRecord[]): void {
    const active = records.filter((record) => this.isActive(record))
    if (active.length === 0) return
    const states = new Map<CacheRecord, PluginControlsState>()
    for (const record of active) {
      states.set(record, {
        snapshot: record.snapshot,
        loading: record.loading,
        refreshing: record.refreshing,
        stale: record.stale,
        error: record.error,
      })
    }
    this.setStates((previous) => {
      const next = new Map(previous)
      for (const [record, state] of states) {
        for (const key of record.keys) {
          if (this.records.get(key) === record) next.set(key, state)
        }
      }
      return next
    })
    for (const record of active) {
      if (record.demands.size > 0 && record.stale) void this.loadRecord(record, true)
    }
  }

  private isActive(record: CacheRecord): boolean {
    return [...record.keys].some((key) => this.records.get(key) === record)
  }

  private adoptCanonicalLocation(
    record: CacheRecord,
    location: PluginControlLocation,
    preferIncoming = false,
    incomingRead?: { snapshot: PluginControlsSnapshot; revision: number },
  ): boolean {
    const canonicalKey = cacheKey(record.instanceId, location)
    const existing = this.records.get(canonicalKey)
    let invalidatedAlias = false
    if (existing && existing !== record) {
      if (preferIncoming || !existing.snapshot) {
        if (preferIncoming) {
          // A mutation can be the first response to reveal a host/canonical
          // alias. Carry the canonical record's newer runtime and event demand
          // across the merge before publishing that mutation's durable rule.
          record.invalidationRevision = Math.max(record.invalidationRevision, existing.invalidationRevision)
          record.stale ||= existing.stale || Boolean(existing.inFlight) || existing.trailing
          if (existing.snapshot && existing.snapshotRevision > record.snapshotRevision) {
            record.snapshot = existing.snapshot
            record.snapshotRevision = existing.snapshotRevision
          }
        }
        // The canonical record may have consumed an event before this alias
        // was known. Its refresh clears stale at dispatch, so retain the
        // generation as well as queued demand before orphaning that read.
        invalidatedAlias = !preferIncoming && (existing.generation > 0 || existing.stale || existing.trailing)
        existing.generation += 1
        existing.inFlightController?.abort()
        this.mergeRecord(existing, record)
      } else {
        // Keep the canonical owner (including its mutation queue), but let a
        // genuinely newer successful alias read recover its failed refresh.
        // Completion order alone cannot authorize replacing newer publications
        // or invalidations; those require a canonical reconciliation instead.
        if (existing.error) {
          if (incomingRead && !existing.inFlight
            && existing.snapshotRevision < incomingRead.revision
            && existing.invalidationRevision < incomingRead.revision) {
            existing.snapshot = incomingRead.snapshot
            existing.snapshotRevision = ++this.revision
            existing.error = undefined
          } else {
            existing.stale = true
          }
        }
        existing.stale ||= record.stale || record.trailing
        record.generation += 1
        record.inFlightController?.abort()
        this.mergeRecord(record, existing)
        this.publish(existing)
        return false
      }
    }
    this.records.set(canonicalKey, record)
    record.keys.add(canonicalKey)
    record.location = { ...location }
    record.canonicalLocation = true
    const pendingInvalidation = this.pendingUnknownInvalidations.get(canonicalKey)
    this.pendingUnknownInvalidations.delete(canonicalKey)
    if (pendingInvalidation !== undefined || invalidatedAlias) {
      if (pendingInvalidation !== undefined) {
        record.invalidationRevision = Math.max(record.invalidationRevision, pendingInvalidation)
      }
      if (preferIncoming) {
        record.stale = true
        return true
      }
      // A canonical event/demand arrived before the WSL alias was learned.
      // Discard this snapshot and retain one trailing refresh, including when
      // the canonical key already had an in-flight record of its own.
      record.generation += 1
      record.stale = true
      record.trailing = true
      this.publish(record)
      return false
    }
    return true
  }

  private mergeRecord(source: CacheRecord, target: CacheRecord): void {
    for (const key of source.keys) {
      if (this.records.get(key) !== source) continue
      this.records.set(key, target)
      target.keys.add(key)
    }
    for (const demand of source.demands) {
      demand.record = target
      target.demands.add(demand)
    }
    source.demands.clear()
  }
}

function retainRuntime(durable: PluginControlsSnapshot, newer: PluginControlsSnapshot): PluginControlsSnapshot {
  const runtimeById = new Map(newer.runtime.flatMap((entry) => entry.id ? [[entry.id, entry] as const] : []))
  const configuredIds = new Set(durable.configured.rules.map((rule) => rule.selector))
  const durableIds = new Set(durable.controls.map((control) => control.id))
  return {
    ...durable,
    runtime: newer.runtime,
    controls: [
      ...durable.controls.flatMap(({ runtime: previousRuntime, ...control }) => {
        const runtime = runtimeById.get(control.id)
        // A removed runtime-only plugin is no longer an inventory control;
        // exact configured IDs (including the durable rule) remain actionable.
        if (!runtime && previousRuntime && !configuredIds.has(control.id)) return []
        return [{ ...control, ...(runtime ? { runtime } : {}) }]
      }),
      ...newer.controls.filter((control) => !durableIds.has(control.id)),
    ],
  }
}

export const pluginControlsCache = new PluginControlsCache(serverApi)

function cacheKey(instanceId: string, location: PluginControlLocation): string {
  return `${JSON.stringify(instanceId)}:${JSON.stringify(location.directory)}`
}
