/**
 * Delta buffer for throttling SSE message.part.delta events.
 *
 * Accumulates text deltas in a 50ms window to reduce UI churn from
 * high-frequency streaming chunks. Provides targeted flush/clear paths
 * so full part-update or message-complete events always win over stale
 * buffered deltas.
 */

const DELTA_FLUSH_INTERVAL = 50

type PendingDelta = { instanceId: string; sessionId?: string; messageId: string; partId: string; field: string; delta: string }
const pendingDeltas = new Map<string, PendingDelta>()
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null

export function enqueueDelta(instanceId: string, messageId: string, partId: string, field: string, delta: string, sessionId?: string) {
  const key = `${instanceId}:${messageId}:${partId}:${field}`
  const existing = pendingDeltas.get(key)
  const accumulated = existing ? existing.delta + delta : delta
  const resolvedSessionId = sessionId ?? existing?.sessionId
  pendingDeltas.set(key, { instanceId, ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}), messageId, partId, field, delta: accumulated })
  if (deltaFlushTimer === null) {
    deltaFlushTimer = setTimeout(flushDeltas, DELTA_FLUSH_INTERVAL)
  }
}

export function holdDelta(instanceId: string, messageId: string, partId: string, field: string, delta: string, sessionId?: string) {
  const key = `${instanceId}:${messageId}:${partId}:${field}`
  const existing = pendingDeltas.get(key)
  const resolvedSessionId = sessionId ?? existing?.sessionId
  pendingDeltas.set(key, { instanceId, ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}), messageId, partId, field, delta: existing ? existing.delta + delta : delta })
}

export function clearPendingDeltasForSession(instanceId: string, sessionId: string): void {
  for (const [key, pending] of pendingDeltas) if (pending.instanceId === instanceId && pending.sessionId === sessionId) pendingDeltas.delete(key)
}

export function clearPendingDeltasForInstance(instanceId: string): void {
  for (const [key, pending] of pendingDeltas) if (pending.instanceId === instanceId) pendingDeltas.delete(key)
}

export function clearPendingDeltasForMessage(instanceId: string, messageId: string): boolean {
  let cleared = false
  for (const [key, pending] of pendingDeltas) {
    if (pending.instanceId !== instanceId || pending.messageId !== messageId) continue
    pendingDeltas.delete(key)
    cleared = true
  }
  return cleared
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

export function flushPendingDeltasForMessage(
  instanceId: string,
  messageId: string,
  applyDelta: (instanceId: string, delta: { messageId: string; partId: string; field: string; delta: string }) => boolean | void
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
      const applied = applyDelta(instanceId, {
        messageId: pending.messageId,
        partId: pending.partId,
        field: pending.field,
        delta: pending.delta,
      })
      if (applied !== false) pendingDeltas.delete(key)
    }
  }
}

export function setFlushCallback(
  callback: (batch: PendingDelta[]) => void
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

let flushCallback: ((batch: PendingDelta[]) => void) | null = null

function flushDeltas() {
  deltaFlushTimer = null
  if (pendingDeltas.size === 0) return
  const batch = Array.from(pendingDeltas.values())
  pendingDeltas.clear()
  if (flushCallback) {
    flushCallback(batch)
  }
}
