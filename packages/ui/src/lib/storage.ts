import type { InstanceData, WorkspaceEventPayload } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { serverEvents } from "./server-events"
import { getLogger } from "./logger"

const log = getLogger("actions")
const UI_CONFIG_CACHE_KEY = "codenomad:config-owner:ui"

export type OwnerBucket = Record<string, any>

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
  private stateOwnerLoadPromises = new Map<string, Promise<OwnerBucket>>()
  private configOwnerListeners = new Map<string, Set<(value: OwnerBucket) => void>>()
  private stateOwnerListeners = new Map<string, Set<(value: OwnerBucket) => void>>()
  private instanceDataCache = new Map<string, InstanceData>()
  private instanceDataListeners = new Map<string, Set<(data: InstanceData) => void>>()
  private instanceLoadPromises = new Map<string, Promise<InstanceData>>()

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

  readCachedConfigOwner(owner: string): OwnerBucket | undefined {
    if (owner !== "ui" || typeof window === "undefined" || !window.localStorage) {
      return undefined
    }

    try {
      const raw = window.localStorage.getItem(UI_CONFIG_CACHE_KEY)
      if (!raw) {
        return undefined
      }
      const parsed = JSON.parse(raw) as OwnerBucket
      return parsed && typeof parsed === "object" ? parsed : undefined
    } catch {
      return undefined
    }
  }

  async loadConfigOwner(owner: string): Promise<OwnerBucket> {
    const cached = this.configOwnerCache.get(owner)
    if (cached) return cached

    if (!this.configOwnerLoadPromises.has(owner)) {
      const promise = serverApi
        .fetchConfigOwner<OwnerBucket>(owner)
        .then((value) => {
          this.setOwnerCache("config", owner, value)
          return value
        })
        .finally(() => {
          this.configOwnerLoadPromises.delete(owner)
        })
      this.configOwnerLoadPromises.set(owner, promise)
    }

    return this.configOwnerLoadPromises.get(owner)!
  }

  async patchConfigOwner(owner: string, patch: unknown): Promise<OwnerBucket> {
    const updated = await serverApi.patchConfigOwner<OwnerBucket>(owner, patch)
    this.setOwnerCache("config", owner, updated)
    return updated
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

  async patchStateOwner(owner: string, patch: unknown): Promise<OwnerBucket> {
    const updated = await serverApi.patchStateOwner<OwnerBucket>(owner, patch)
    this.setOwnerCache("state", owner, updated)
    return updated
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

  async saveInstanceData(instanceId: string, data: InstanceData): Promise<void> {
    const normalized = this.normalizeInstanceData(data)
    await serverApi.writeInstanceData(instanceId, normalized)
    this.setInstanceDataCache(instanceId, normalized)
  }

  async deleteInstanceData(instanceId: string): Promise<void> {
    await serverApi.deleteInstanceData(instanceId)
    this.setInstanceDataCache(instanceId, DEFAULT_INSTANCE_DATA)
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
        this.configOwnerCache.clear()
      } else {
        this.stateOwnerCache.clear()
      }
      return
    }

    const cache = kind === "config" ? this.configOwnerCache : this.stateOwnerCache
    const listeners = kind === "config" ? this.configOwnerListeners : this.stateOwnerListeners

    const previous = cache.get(owner)
    if (previous && isDeepEqual(previous, value)) {
      cache.set(owner, value)
      return
    }
    cache.set(owner, value)
    if (kind === "config" && owner === "ui") {
      this.persistUiConfigCache(value)
    }
    const bucket = listeners.get(owner)
    if (!bucket) return
    for (const listener of bucket) {
      listener(value)
    }
  }

  private persistUiConfigCache(value: OwnerBucket) {
    if (typeof window === "undefined" || !window.localStorage) {
      return
    }

    try {
      window.localStorage.setItem(UI_CONFIG_CACHE_KEY, JSON.stringify(value))
    } catch {
      /* noop */
    }
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
