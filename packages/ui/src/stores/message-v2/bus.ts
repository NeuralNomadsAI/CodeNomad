import { createInstanceMessageStore } from "./instance-store"
import type { InstanceMessageStore } from "./instance-store"
import { clearCacheForInstance, clearCacheForSession } from "../../lib/global-cache"
import { getLogger } from "../../lib/logger"
import type { ScrollSnapshot } from "./types"

const log = getLogger("session")

export interface MessageScrollSnapshotSeed {
  sessionId: string
  scope: string
  snapshot: ScrollSnapshot
}

class MessageStoreBus {
  private stores = new Map<string, InstanceMessageStore>()
  private teardownHandlers = new Set<(instanceId: string) => void>()
  private sessionClearHandlers = new Set<(instanceId: string, sessionId: string) => void>()
  private sessionChangeHandlers = new Set<(instanceId: string, sessionId: string) => void>()
  private scrollSnapshotHandlers = new Set<
    (instanceId: string, sessionId: string, scope: string, snapshot: ScrollSnapshot) => void
  >()
  private scrollSnapshotSeeds = new Map<string, MessageScrollSnapshotSeed[]>()

  registerInstance(instanceId: string, store?: InstanceMessageStore): InstanceMessageStore {
    if (this.stores.has(instanceId)) {
      return this.stores.get(instanceId) as InstanceMessageStore
    }

    const resolved =
      store ??
      createInstanceMessageStore(instanceId, {
        onSessionCleared: (id, sessionId) => this.notifySessionCleared(id, sessionId),
        onSessionChanged: (id, sessionId) => this.notifySessionChanged(id, sessionId),
        onScrollSnapshotChanged: (id, sessionId, scope, snapshot) =>
          this.notifyScrollSnapshotChanged(id, sessionId, scope, snapshot),
      })
    this.stores.set(instanceId, resolved)
    const seeds = this.scrollSnapshotSeeds.get(instanceId)
    if (seeds) {
      this.scrollSnapshotSeeds.delete(instanceId)
      for (const seed of seeds) {
        this.applyScrollSeed(resolved, seed)
      }
    }
    return resolved
  }

  onSessionCleared(handler: (instanceId: string, sessionId: string) => void): () => void {
    this.sessionClearHandlers.add(handler)
    return () => {
      this.sessionClearHandlers.delete(handler)
    }
  }

  private notifySessionCleared(instanceId: string, sessionId: string) {
    clearCacheForSession(instanceId, sessionId)
    for (const handler of this.sessionClearHandlers) {
      try {
        handler(instanceId, sessionId)
      } catch (error) {
        log.error("Failed to run session clear handler", error)
      }
    }
  }

  onSessionChanged(handler: (instanceId: string, sessionId: string) => void): () => void {
    this.sessionChangeHandlers.add(handler)
    return () => this.sessionChangeHandlers.delete(handler)
  }

  private notifySessionChanged(instanceId: string, sessionId: string) {
    for (const handler of this.sessionChangeHandlers) {
      try {
        handler(instanceId, sessionId)
      } catch (error) {
        log.error("Failed to run session change handler", error)
      }
    }
  }

  onScrollSnapshotChanged(
    handler: (instanceId: string, sessionId: string, scope: string, snapshot: ScrollSnapshot) => void,
  ): () => void {
    this.scrollSnapshotHandlers.add(handler)
    return () => {
      this.scrollSnapshotHandlers.delete(handler)
    }
  }

  seedScrollSnapshots(instanceId: string, seeds: MessageScrollSnapshotSeed[]): void {
    if (seeds.length === 0) return
    const store = this.stores.get(instanceId)
    if (store) {
      for (const seed of seeds) {
        this.applyScrollSeed(store, seed)
      }
      return
    }
    this.scrollSnapshotSeeds.set(instanceId, seeds)
  }

  private applyScrollSeed(store: InstanceMessageStore, seed: MessageScrollSnapshotSeed): void {
    const current = store.getScrollSnapshot(seed.sessionId, seed.scope)
    if (current && current.updatedAt >= seed.snapshot.updatedAt) return
    store.restoreScrollSnapshot(seed.sessionId, seed.scope, seed.snapshot)
  }

  private notifyScrollSnapshotChanged(
    instanceId: string,
    sessionId: string,
    scope: string,
    snapshot: ScrollSnapshot,
  ): void {
    for (const handler of this.scrollSnapshotHandlers) {
      try {
        handler(instanceId, sessionId, scope, snapshot)
      } catch (error) {
        log.error("Failed to run scroll snapshot change handler", error)
      }
    }
  }

  getInstance(instanceId: string): InstanceMessageStore | undefined {
    return this.stores.get(instanceId)
  }

  getOrCreate(instanceId: string): InstanceMessageStore {
    return this.registerInstance(instanceId)
  }

  clearInstanceScrollSnapshots(instanceId: string): void {
    this.stores.get(instanceId)?.clearScrollSnapshots()
    this.scrollSnapshotSeeds.delete(instanceId)
  }

  onInstanceDestroyed(handler: (instanceId: string) => void): () => void {
    this.teardownHandlers.add(handler)
    return () => {
      this.teardownHandlers.delete(handler)
    }
  }

  unregisterInstance(instanceId: string) {
    const store = this.stores.get(instanceId)
    if (store) {
      store.clearInstance()
    }
    clearCacheForInstance(instanceId)
    this.notifyInstanceDestroyed(instanceId)
    this.stores.delete(instanceId)
    this.scrollSnapshotSeeds.delete(instanceId)
  }

  clearAll() {
    for (const [instanceId, store] of this.stores.entries()) {
      store.clearInstance()
      clearCacheForInstance(instanceId)
      this.notifyInstanceDestroyed(instanceId)
      this.stores.delete(instanceId)
      this.scrollSnapshotSeeds.delete(instanceId)
    }
    this.scrollSnapshotSeeds.clear()
  }

  private notifyInstanceDestroyed(instanceId: string) {
    for (const handler of this.teardownHandlers) {
      try {
        handler(instanceId)
      } catch (error) {
        log.error("Failed to run message store teardown handler", error)
      }
    }
  }
}

export const messageStoreBus = new MessageStoreBus()
