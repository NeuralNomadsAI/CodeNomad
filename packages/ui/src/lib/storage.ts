import type { AppConfig, InstanceData } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { serverEvents } from "./server-events"
import { getLogger } from "./logger"

const log = getLogger("actions")

export type ConfigData = AppConfig

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
  private configChangeListeners: Set<(config: ConfigData) => void> = new Set()
  private configCache: ConfigData | null = null
  private loadPromise: Promise<ConfigData> | null = null
  private instanceDataCache = new Map<string, InstanceData>()
  private instanceDataListeners = new Map<string, Set<(data: InstanceData) => void>>()
  private instanceLoadPromises = new Map<string, Promise<InstanceData>>()

  constructor() {
    serverEvents.on("config.appChanged", (event) => {
      if (event.type !== "config.appChanged") return
      this.setConfigCache(event.config)
    })

    serverEvents.on("instance.dataChanged", (event) => {
      if (event.type !== "instance.dataChanged") return
      this.setInstanceDataCache(event.instanceId, event.data)
    })
  }

  async loadConfig(): Promise<ConfigData> {
    if (this.configCache) {
      return this.configCache
    }

    if (!this.loadPromise) {
      this.loadPromise = serverApi
        .fetchConfig()
        .then((config) => {
          this.setConfigCache(config)
          return config
        })
        .finally(() => {
          this.loadPromise = null
        })
    }

    return this.loadPromise
  }

  async updateConfig(next: ConfigData): Promise<ConfigData> {
    const nextConfig = await serverApi.updateConfig(next)
    this.setConfigCache(nextConfig)
    return nextConfig
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

  onConfigChanged(listener: (config: ConfigData) => void): () => void {
    this.configChangeListeners.add(listener)
    if (this.configCache) {
      listener(this.configCache)
    }
    return () => this.configChangeListeners.delete(listener)
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

  private setConfigCache(config: ConfigData) {
    if (this.configCache && isDeepEqual(this.configCache, config)) {
      this.configCache = config
      return
    }
    this.configCache = config
    this.notifyConfigChanged(config)
  }

  private notifyConfigChanged(config: ConfigData) {
    for (const listener of this.configChangeListeners) {
      listener(config)
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
