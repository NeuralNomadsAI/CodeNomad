import type { OpenCodeEvent } from "@opencode/client"
import { captureBackendOperation } from "../lib/backend-operation"

type CompactionDelta = Extract<OpenCodeEvent, { type: "session.compaction.delta" }>
const INTERVAL_MS = 250

// Only payload aggregation lives here. Revision/read authority remains with the
// native reducer owner, which cancels or flushes this buffer at its boundaries.
export function createCompactionDeltaBuffer<Context>(reduce: (event: CompactionDelta, context: Context) => void) {
  const pending = new Map<string, {
    event: CompactionDelta
    context: Context
    operation: ReturnType<typeof captureBackendOperation>
    timeout: ReturnType<typeof setTimeout>
  }>()
  const keyFor = (instanceId: string, sessionId: string) => `${instanceId}\0${sessionId}`

  const flush = (instanceId: string, sessionId: string) => {
    const key = keyFor(instanceId, sessionId)
    const item = pending.get(key)
    if (!item) return
    clearTimeout(item.timeout)
    pending.delete(key)
    if (item.operation.current()) reduce(item.event, item.context)
  }
  return {
    flush,
    push(instanceId: string, sessionId: string, event: CompactionDelta, context: Context) {
      const operation = captureBackendOperation(instanceId)
      if (!operation.current()) return
      const key = keyFor(instanceId, sessionId)
      const item = pending.get(key)
      if (item && item.operation.signal === operation.signal) {
        item.event = { ...event, data: { ...event.data, text: item.event.data.text + event.data.text } }
        item.context = context
        return
      }
      if (item) clearTimeout(item.timeout)
      pending.set(key, {
        event,
        context,
        operation,
        timeout: setTimeout(() => {
          if (pending.get(key)?.operation === operation) flush(instanceId, sessionId)
        }, INTERVAL_MS),
      })
    },
    cancel(instanceId: string, sessionId: string) {
      const key = keyFor(instanceId, sessionId)
      const item = pending.get(key)
      if (!item) return
      clearTimeout(item.timeout)
      pending.delete(key)
    },
    clear(instanceId: string) {
      const prefix = `${instanceId}\0`
      for (const [key, item] of pending) {
        if (!key.startsWith(prefix)) continue
        clearTimeout(item.timeout)
        pending.delete(key)
      }
    },
  }
}
