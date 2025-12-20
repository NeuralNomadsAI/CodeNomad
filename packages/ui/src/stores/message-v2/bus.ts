import { createSignal } from "solid-js"
import { createInstanceMessageStore } from "./instance-store"
import type { InstanceMessageStore } from "./instance-store"
import { clearCacheForInstance } from "../../lib/global-cache"
import { getLogger } from "../../lib/logger"

const log = getLogger("session")

// Signal to trigger auto-collapse of tool calls when user submits a new message
const [collapseGeneration, setCollapseGeneration] = createSignal(0)

export function triggerCollapseAll() {
  setCollapseGeneration((prev) => prev + 1)
}

export { collapseGeneration }

class MessageStoreBus {
  private stores = new Map<string, InstanceMessageStore>()
  private teardownHandlers = new Set<(instanceId: string) => void>()
  private sessionClearHandlers = new Set<(instanceId: string, sessionId: string) => void>()

  registerInstance(instanceId: string, store?: InstanceMessageStore): InstanceMessageStore {
    if (this.stores.has(instanceId)) {
      return this.stores.get(instanceId) as InstanceMessageStore
    }

    const resolved =
      store ??
      createInstanceMessageStore(instanceId, {
        onSessionCleared: (id, sessionId) => this.notifySessionCleared(id, sessionId),
      })
    this.stores.set(instanceId, resolved)
    return resolved
  }

  onSessionCleared(handler: (instanceId: string, sessionId: string) => void): () => void {
    this.sessionClearHandlers.add(handler)
    return () => {
      this.sessionClearHandlers.delete(handler)
    }
  }

  private notifySessionCleared(instanceId: string, sessionId: string) {
    for (const handler of this.sessionClearHandlers) {
      try {
        handler(instanceId, sessionId)
      } catch (error) {
        log.error("Failed to run session clear handler", error)
      }
    }
  }

  getInstance(instanceId: string): InstanceMessageStore | undefined {
    return this.stores.get(instanceId)
  }

  getOrCreate(instanceId: string): InstanceMessageStore {
    return this.registerInstance(instanceId)
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
  }

  clearAll() {
    for (const [instanceId, store] of this.stores.entries()) {
      store.clearInstance()
      clearCacheForInstance(instanceId)
      this.notifyInstanceDestroyed(instanceId)
      this.stores.delete(instanceId)
    }
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
