import type { WorkspaceEventPayload } from "../../../server/src/api-types"
import { serverApi } from "./api-client"

export interface WorkspaceEventTransportCallbacks {
  onBatch: (events: WorkspaceEventPayload[]) => void
  onError?: () => void
  onOpen?: () => void
  onStatus?: (status: WorkspaceEventTransportStatus) => void
  onPing?: (payload: { ts?: number }) => void
}

export type WorkspaceEventTransportStatus = "connecting" | "connected" | "disconnected"

export interface WorkspaceEventConnection {
  disconnect: () => void
}

export async function connectWorkspaceEvents(
  callbacks: WorkspaceEventTransportCallbacks,
): Promise<WorkspaceEventConnection> {
  // The stream delivers one event per frame, but the reactive pass must not
  // run once per frame: a main thread draining queued frames would reduce the
  // same window once per event. Buffer same-tick arrivals and flush them as a
  // single batch, preserving arrival order.
  let pending: WorkspaceEventPayload[] = []
  let flushScheduled = false
  const flushNow = () => {
    if (pending.length === 0) return
    const events = pending
    pending = []
    callbacks.onBatch(events)
  }
  const scheduleFlush = () => {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(() => {
      flushScheduled = false
      flushNow()
    })
  }
  const notifyDisconnected = () => {
    // Events already delivered by the stream must reach the batch handler
    // before the connection is reported dead; the reconnect fence in
    // server-events drops anything flushed after the generation moves on.
    flushNow()
    callbacks.onStatus?.("disconnected")
    callbacks.onError?.()
  }
  const source = serverApi.connectEvents((event) => {
    pending.push(event)
    scheduleFlush()
  }, notifyDisconnected, callbacks.onPing)
  source.onopen = () => {
    callbacks.onStatus?.("connected")
    callbacks.onOpen?.()
  }
  return {
    disconnect() {
      flushNow()
      source.close()
    },
  }
}
