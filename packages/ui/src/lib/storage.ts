import type { InstanceData, WorkspaceEventPayload } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { serverEvents } from "./server-events"
import { getLogger } from "./logger"
import type { MissionPreferenceExpectation } from "./mission-preferences-document"

const log = getLogger("actions")

export type OwnerBucket = Record<string, any>

/** The write was acknowledged, but no ordered owner snapshot could be obtained. */
export class ConfigOwnerReconciliationPendingError extends Error {
  readonly code = "owner-reconciliation-pending"
  readonly mutationCommitted = true
  constructor(readonly owner: string) { super("Saved configuration owner requires explicit reconciliation") }
}

const DEFAULT_INSTANCE_DATA: InstanceData = {
  messageHistory: [],
  agentModelSelections: {},
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }

  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {

    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch (error) {
      log.warn("Failed to compare config objects", error)
    }
  }

  return false
}

export class ServerStorage {
  private configOwnerCache = new Map<string, OwnerBucket>()
  private stateOwnerCache = new Map<string, OwnerBucket>()
  private configOwnerLoadPromises = new Map<string, Promise<OwnerBucket>>()
  private configOwnerEpochs = new Map<string, number>()
  private configInvalidationEpoch = 0
  private stateOwnerLoadPromises = new Map<string, Promise<OwnerBucket>>()
  private configOwnerListeners = new Map<string, Set<(value: OwnerBucket) => void>>()
  private stateOwnerListeners = new Map<string, Set<(value: OwnerBucket) => void>>()
  private instanceDataCache = new Map<string, InstanceData>()
  private instanceDataListeners = new Map<string, Set<(data: InstanceData) => void>>()
  private instanceLoadPromises = new Map<string, Promise<InstanceData>>()
  private pendingWrites = new Set<Promise<unknown>>()

  constructor() {
    serverEvents.on("storage.configChanged", (event: WorkspaceEventPayload) => {
      if (event.type !== "storage.configChanged") return
      this.setOwnerCache("config", event.owner, event.value)
    })

    serverEvents.on("storage.stateChanged", (event: WorkspaceEventPayload) => {
      if (event.type !== "storage.stateChanged") return
      this.setOwnerCache("state", event.owner, event.value)
    })

    serverEvents.on("instance.dataChanged", (event) => {
      if (event.type !== "instance.dataChanged") return
      this.setInstanceDataCache(event.instanceId, event.data)
    })
  }

  async loadConfigOwner(owner: string): Promise<OwnerBucket> {
    const cached = this.configOwnerCache.get(owner)
    if (cached) return cached

    if (!this.configOwnerLoadPromises.has(owner)) {
      const promise = this.readConfigOwner(owner)
        .finally(() => {
          this.configOwnerLoadPromises.delete(owner)
        })
      this.configOwnerLoadPromises.set(owner, promise)
    }

    return this.configOwnerLoadPromises.get(owner)!
  }

  patchConfigOwner(owner: string, patch: unknown): Promise<OwnerBucket> {
    const epoch = this.configOwnerEpochs.get(owner) ?? 0, invalidation = this.configInvalidationEpoch
    return this.trackWrite(serverApi.patchConfigOwner<OwnerBucket>(owner, patch)
      .then(updated => this.acceptConfigWrite(owner, epoch, invalidation, updated)))
  }

  async revalidateUiConfigOwner(): Promise<OwnerBucket> {
    return this.readStableConfigOwner("ui")
  }

  private async readConfigOwner(owner: string): Promise<OwnerBucket> {
    const epoch = this.configOwnerEpochs.get(owner) ?? 0, invalidation = this.configInvalidationEpoch
    const value = await serverApi.fetchConfigOwner<OwnerBucket>(owner)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration owner response")
    // A completed older GET cannot supersede a newer native event or write.
    if (epoch !== (this.configOwnerEpochs.get(owner) ?? 0) || invalidation !== this.configInvalidationEpoch) {
      const current = this.configOwnerCache.get(owner)
      if (!current) throw new Error("Configuration changed during read; reload")
      return current
    }
    this.setOwnerCache("config", owner, value)
    return value
  }

  patchMissionPreferences(patch: unknown, expected: MissionPreferenceExpectation[]): Promise<OwnerBucket> {
    const epoch = this.configOwnerEpochs.get("ui") ?? 0, invalidation = this.configInvalidationEpoch
    return this.trackWrite(serverApi.patchMissionPreferences<OwnerBucket>(patch, expected)
      .then(updated => this.acceptConfigWrite("ui", epoch, invalidation, updated)))
  }

  private acceptConfigWrite(owner: string, epoch: number, invalidation: number, updated: OwnerBucket): OwnerBucket | Promise<OwnerBucket> {
    // An intervening event may precede OR follow this write. Neither the ACK nor
    // that cache has a certified order. Read native owner authority, never replay.
    if (epoch !== (this.configOwnerEpochs.get(owner) ?? 0) || invalidation !== this.configInvalidationEpoch) {
      return this.reconcileConfigWrite(owner)
    }
    this.setOwnerCache("config", owner, updated)
    return updated
  }

  private async reconcileConfigWrite(owner: string): Promise<OwnerBucket> {
    try { return await this.readStableConfigOwner(owner) }
    catch { throw new ConfigOwnerReconciliationPendingError(owner) }
  }

  private async readStableConfigOwner(owner: string): Promise<OwnerBucket> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = this.configOwnerEpochs.get(owner) ?? 0, invalidation = this.configInvalidationEpoch
      try {
        const value = await serverApi.fetchConfigOwner<OwnerBucket>(owner, AbortSignal.timeout(10_000))
        if (!value || typeof value !== "object" || Array.isArray(value)) continue
        // This strict read must not substitute a potentially older display cache.
        if (epoch !== (this.configOwnerEpochs.get(owner) ?? 0) || invalidation !== this.configInvalidationEpoch) continue
        this.setOwnerCache("config", owner, value)
        return value
      } catch { /* A bounded read-only retry is not mutation replay. */ }
    }
    throw new Error("Configuration owner could not be read authoritatively; explicit reload required")
  }

  async loadStateOwner(owner: string): Promise<OwnerBucket> {
    const cached = this.stateOwnerCache.get(owner)
    if (cached) return cached

    if (!this.stateOwnerLoadPromises.has(owner)) {
      const promise = serverApi
        .fetchStateOwner<OwnerBucket>(owner)
        .then((value) => {
          this.setOwnerCache("state", owner, value)
          return value
        })
        .finally(() => {
          this.stateOwnerLoadPromises.delete(owner)
        })
      this.stateOwnerLoadPromises.set(owner, promise)
    }

    return this.stateOwnerLoadPromises.get(owner)!
  }

  patchStateOwner(owner: string, patch: unknown): Promise<OwnerBucket> {
    return this.trackWrite(serverApi.patchStateOwner<OwnerBucket>(owner, patch).then((updated) => {
      this.setOwnerCache("state", owner, updated)
      return updated
    }))
  }

  async loadInstanceData(instanceId: string): Promise<InstanceData> {
    const cached = this.instanceDataCache.get(instanceId)
    if (cached) {
      return cached
    }

    if (!this.instanceLoadPromises.has(instanceId)) {
      const promise = serverApi
        .readInstanceData(instanceId)
        .then((data) => {
          const normalized = this.normalizeInstanceData(data)
          this.setInstanceDataCache(instanceId, normalized)
          return normalized
        })
        .finally(() => {
          this.instanceLoadPromises.delete(instanceId)
        })

      this.instanceLoadPromises.set(instanceId, promise)
    }

    return this.instanceLoadPromises.get(instanceId)!
  }

  saveInstanceData(instanceId: string, data: InstanceData): Promise<void> {
    const normalized = this.normalizeInstanceData(data)
    return this.trackWrite(serverApi.writeInstanceData(instanceId, normalized).then(() => {
      this.setInstanceDataCache(instanceId, normalized)
    }))
  }

  deleteInstanceData(instanceId: string): Promise<void> {
    return this.trackWrite(serverApi.deleteInstanceData(instanceId).then(() => {
      this.setInstanceDataCache(instanceId, DEFAULT_INSTANCE_DATA)
    }))
  }

  async flushWrites(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.allSettled(this.pendingWrites)
    }
  }

  onConfigOwnerChanged(owner: string, listener: (value: OwnerBucket) => void): () => void {
    if (!this.configOwnerListeners.has(owner)) {
      this.configOwnerListeners.set(owner, new Set())
    }
    const bucket = this.configOwnerListeners.get(owner)!
    bucket.add(listener)
    const cached = this.configOwnerCache.get(owner)
    if (cached) {
      listener(cached)
    }
    return () => {
      bucket.delete(listener)
      if (bucket.size === 0) {
        this.configOwnerListeners.delete(owner)
      }
    }
  }

  onStateOwnerChanged(owner: string, listener: (value: OwnerBucket) => void): () => void {
    if (!this.stateOwnerListeners.has(owner)) {
      this.stateOwnerListeners.set(owner, new Set())
    }
    const bucket = this.stateOwnerListeners.get(owner)!
    bucket.add(listener)
    const cached = this.stateOwnerCache.get(owner)
    if (cached) {
      listener(cached)
    }
    return () => {
      bucket.delete(listener)
      if (bucket.size === 0) {
        this.stateOwnerListeners.delete(owner)
      }
    }
  }

  onInstanceDataChanged(instanceId: string, listener: (data: InstanceData) => void): () => void {
    if (!this.instanceDataListeners.has(instanceId)) {
      this.instanceDataListeners.set(instanceId, new Set())
    }
    const bucket = this.instanceDataListeners.get(instanceId)!
    bucket.add(listener)
    const cached = this.instanceDataCache.get(instanceId)
    if (cached) {
      listener(cached)
    }
    return () => {
      bucket.delete(listener)
      if (bucket.size === 0) {
        this.instanceDataListeners.delete(instanceId)
      }
    }
  }

  private setOwnerCache(kind: "config" | "state", owner: string, value: OwnerBucket) {
    if (owner === "*") {
      // Full-doc updates are not tracked owner-by-owner; invalidate caches.
      if (kind === "config") {
        this.configInvalidationEpoch++
        this.configOwnerCache.clear()
      } else {
        this.stateOwnerCache.clear()
      }
      return
    }

    const cache = kind === "config" ? this.configOwnerCache : this.stateOwnerCache
    if (kind === "config") this.configOwnerEpochs.set(owner, (this.configOwnerEpochs.get(owner) ?? 0) + 1)
    const listeners = kind === "config" ? this.configOwnerListeners : this.stateOwnerListeners

    const previous = cache.get(owner)
    if (previous && isDeepEqual(previous, value)) {
      cache.set(owner, value)
      return
    }
    cache.set(owner, value)
    const bucket = listeners.get(owner)
    if (!bucket) return
    for (const listener of bucket) {
      listener(value)
    }
  }

  private trackWrite<T>(write: Promise<T>): Promise<T> {
    this.pendingWrites.add(write)
    void write.finally(() => this.pendingWrites.delete(write)).catch(() => undefined)
    return write
  }

  private normalizeInstanceData(data?: InstanceData | null): InstanceData {
    const source = data ?? DEFAULT_INSTANCE_DATA
    const messageHistory = Array.isArray(source.messageHistory) ? [...source.messageHistory] : []
    const agentModelSelections = { ...(source.agentModelSelections ?? {}) }
    return {
      ...source,
      messageHistory,
      agentModelSelections,
    }
  }

  private setInstanceDataCache(instanceId: string, data: InstanceData) {
    const normalized = this.normalizeInstanceData(data)
    const previous = this.instanceDataCache.get(instanceId)
    if (previous && isDeepEqual(previous, normalized)) {
      this.instanceDataCache.set(instanceId, normalized)
      return
    }
    this.instanceDataCache.set(instanceId, normalized)
    this.notifyInstanceDataChanged(instanceId, normalized)
  }

  private notifyInstanceDataChanged(instanceId: string, data: InstanceData) {
    const listeners = this.instanceDataListeners.get(instanceId)
    if (!listeners) {
      return
    }
    for (const listener of listeners) {
      listener(data)
    }
  }
}

export const storage = new ServerStorage()
