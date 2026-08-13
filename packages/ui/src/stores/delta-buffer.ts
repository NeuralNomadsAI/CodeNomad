/**
 * Delta buffer for throttling SSE message.part.delta events.
 *
 * Accumulates text deltas in a 50ms window to reduce UI churn from
 * high-frequency streaming chunks. Provides targeted flush/clear paths
 * so full part-update or message-complete events always win over stale
 * buffered deltas.
 */

const DELTA_FLUSH_INTERVAL = 50

const pendingDeltas = new Map<string, { instanceId: string; messageId: string; partId: string; field: string; delta: string }>()
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null

export function enqueueDelta(instanceId: string, messageId: string, partId: string, field: string, delta: string) {
  const key = `${instanceId}:${messageId}:${partId}:${field}`
  const existing = pendingDeltas.get(key)
  const accumulated = existing ? existing.delta + delta : delta
  pendingDeltas.set(key, { instanceId, messageId, partId, field, delta: accumulated })
  if (deltaFlushTimer === null) {
    deltaFlushTimer = setTimeout(flushDeltas, DELTA_FLUSH_INTERVAL)
  }
}

export function clearPendingDeltasForPart(instanceId: string, messageId: string, partId: string) {
  const keysToDelete: string[] = []
  for (const key of pendingDeltas.keys()) {
    if (key.startsWith(`${instanceId}:${messageId}:${partId}:`)) {
      keysToDelete.push(key)
    }
  }
  for (const key of keysToDelete) {
    pendingDeltas.delete(key)
  }
}

export function clearPendingDeltasForInstance(instanceId: string): void {
  for (const [key, pending] of pendingDeltas) {
    if (pending.instanceId === instanceId) pendingDeltas.delete(key)
  }
  if (pendingDeltas.size === 0 && deltaFlushTimer !== null) {
    clearTimeout(deltaFlushTimer)
    deltaFlushTimer = null
  }
}

export function flushPendingDeltasForMessage(
  instanceId: string,
  messageId: string,
  applyDelta: (instanceId: string, delta: { messageId: string; partId: string; field: string; delta: string }) => void
): void {
  const prefix = `${instanceId}:${messageId}:`
  const keysToFlush: string[] = []
  for (const key of pendingDeltas.keys()) {
    if (key.startsWith(prefix)) {
      keysToFlush.push(key)
    }
  }
  for (const key of keysToFlush) {
    const pending = pendingDeltas.get(key)
    if (pending) {
      pendingDeltas.delete(key)
      applyDelta(instanceId, {
        messageId: pending.messageId,
        partId: pending.partId,
        field: pending.field,
        delta: pending.delta,
      })
    }
  }
}

export function setFlushCallback(
  callback: (batch: Array<{ instanceId: string; messageId: string; partId: string; field: string; delta: string }>) => void
) {
  // Store callback for flushDeltas to use
  flushCallback = callback
}

export function resetDeltaBufferForTests() {
  pendingDeltas.clear()
  if (deltaFlushTimer !== null) {
    clearTimeout(deltaFlushTimer)
    deltaFlushTimer = null
  }
  flushCallback = null
}

let flushCallback: ((batch: Array<{ instanceId: string; messageId: string; partId: string; field: string; delta: string }>) => void) | null = null

function flushDeltas() {
  deltaFlushTimer = null
  if (pendingDeltas.size === 0) return
  const batch = Array.from(pendingDeltas.values())
  pendingDeltas.clear()
  if (flushCallback) {
    flushCallback(batch)
  }
}
