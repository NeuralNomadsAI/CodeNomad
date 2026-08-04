import { invoke } from "@tauri-apps/api/core"
import { emit, listen } from "@tauri-apps/api/event"
import type { WorkspaceEventPayload } from "../../../../server/src/api-types"
import type {
  DesktopEventsStartResult,
  DesktopEventTransportStartOptions,
  DesktopEventTransportState,
  DesktopEventTransportStatusPayload,
} from "../event-transport-contract"
import type {
  WorkspaceEventConnection,
  WorkspaceEventTransportCallbacks,
  WorkspaceEventTransportStatus,
} from "../event-transport"
import {
  acquireEventTransportCursorAuthority,
  type EventTransportCursorAuthority,
} from "../event-transport-cursor"
import { getLogger } from "../logger"

const log = getLogger("sse")

interface WorkspaceEventBatchPayload {
  generation: number
  sequence: number
  emittedAt: number
  events: WorkspaceEventPayload[]
  lastEventId?: string | null
}

interface WorkspaceEventReplayResetPayload {
  generation: number
  details: unknown
  lastEventId?: string | null
}

type PendingNativePayload =
  | { type: "batch"; payload: WorkspaceEventBatchPayload }
  | { type: "status"; payload: DesktopEventTransportStatusPayload }
  | { type: "reset"; payload: WorkspaceEventReplayResetPayload }

const MAX_PENDING_NATIVE_PAYLOADS = 4096

interface DesktopEventTransportBridge {
  invoke: typeof invoke
  listen: typeof listen
  emit: typeof emit
}

const defaultDesktopEventTransportBridge: DesktopEventTransportBridge = {
  invoke,
  listen,
  emit,
}

export function createTerminalErrorNotifier(callbacks: Pick<WorkspaceEventTransportCallbacks, "onError">) {
  let raised = false
  return () => {
    if (raised) return
    raised = true
    callbacks.onError?.()
  }
}

export function mapDesktopEventTransportStatus(
  state: DesktopEventTransportState,
): WorkspaceEventTransportStatus {
  if (state === "connected") return "connected"
  if (state === "connecting") return "connecting"
  return "disconnected"
}

export async function connectTauriWorkspaceEvents(
  callbacks: WorkspaceEventTransportCallbacks,
  options: DesktopEventTransportStartOptions,
  bridge: DesktopEventTransportBridge = defaultDesktopEventTransportBridge,
  cursor: EventTransportCursorAuthority = acquireEventTransportCursorAuthority(),
): Promise<WorkspaceEventConnection> {
  let closed = false
  let opened = false
  let expectedGeneration: number | null = null
  let leaseId: number | undefined
  const notifyTerminalError = createTerminalErrorNotifier(callbacks)
  const pending: PendingNativePayload[] = []
  let pendingOverflow = false

  const matchesGeneration = (generation: number) => expectedGeneration === generation
  const acknowledge = (generation: number, eventCursor: string | null | undefined) => {
    if (!eventCursor || !cursor.commit(eventCursor)) return
    void bridge.emit("desktop:event-ack", { generation, lastEventId: eventCursor }).catch((error) => {
      log.warn("Failed to acknowledge native desktop events", error)
    })
  }

  const handleBatchPayload = (payload: WorkspaceEventBatchPayload) => {
    if (!payload || !matchesGeneration(payload.generation)) return

    if (!opened) {
      opened = true
      callbacks.onStatus?.("connected")
      callbacks.onOpen?.()
    }

    const events = payload.events ?? []
    const accepted = callbacks.onBatch(events) !== false
    if (accepted) acknowledge(payload.generation, payload.lastEventId)
  }

  const handleStatusPayload = (payload: DesktopEventTransportStatusPayload) => {
    if (!payload || !matchesGeneration(payload.generation)) return

    callbacks.onStatus?.(mapDesktopEventTransportStatus(payload.state))

    if (payload.state === "disconnected" || payload.state === "error" || payload.state === "unauthorized") {
      opened = false
    }

    if (payload.state === "connected" && !opened) {
      opened = true
      callbacks.onOpen?.()
    }

    if (payload.state === "unauthorized") {
      log.warn("Native desktop event transport is waiting for authentication", {
        reason: payload.reason,
        reconnectAttempt: payload.reconnectAttempt,
        nextDelayMs: payload.nextDelayMs,
        stats: payload.stats,
      })
    } else if (payload.state === "error") {
      log.warn("Native desktop event transport reported an error", {
        reason: payload.reason,
        reconnectAttempt: payload.reconnectAttempt,
        nextDelayMs: payload.nextDelayMs,
        statusCode: payload.statusCode,
        stats: payload.stats,
      })
    } else if ((payload.state === "disconnected" || payload.state === "stopped") && payload.stats) {
      log.info("Native desktop event transport stats", {
        state: payload.state,
        reconnectAttempt: payload.reconnectAttempt,
        stats: payload.stats,
      })
    }

    if (payload.state === "stopped") {
      notifyTerminalError()
      return
    }

    if (payload.terminal) {
      notifyTerminalError()
    }
  }

  const handleReplayResetPayload = (payload: WorkspaceEventReplayResetPayload) => {
    if (!payload || !matchesGeneration(payload.generation)) return
    const accepted = callbacks.onReplayReset?.() !== false
    if (accepted) acknowledge(payload.generation, payload.lastEventId)
  }

  const flushPending = () => {
    if (expectedGeneration === null) return
    if (pendingOverflow) {
      pending.length = 0
      callbacks.onReplayReset?.()
      throw new Error("native event startup queue overflowed")
    }
    for (const entry of pending.splice(0, pending.length)) {
      if (entry.type === "batch") handleBatchPayload(entry.payload)
      else if (entry.type === "status") handleStatusPayload(entry.payload)
      else handleReplayResetPayload(entry.payload)
    }
  }

  const queuePending = (entry: PendingNativePayload) => {
    if (pendingOverflow) return
    if (pending.length >= MAX_PENDING_NATIVE_PAYLOADS) {
      pending.length = 0
      pendingOverflow = true
      return
    }
    pending.push(entry)
  }

  let unlistenBatch: () => void = () => undefined
  let unlistenStatus: () => void = () => undefined
  let unlistenReplayReset: () => void = () => undefined

  try {
    unlistenBatch = await bridge.listen<WorkspaceEventBatchPayload>("desktop:event-batch", (event) => {
      if (closed || !event.payload) return
      if (expectedGeneration === null) queuePending({ type: "batch", payload: event.payload })
      else handleBatchPayload(event.payload)
    })
    unlistenStatus = await bridge.listen<DesktopEventTransportStatusPayload>("desktop:event-stream-status", (event) => {
      if (closed || !event.payload) return
      if (expectedGeneration === null) queuePending({ type: "status", payload: event.payload })
      else handleStatusPayload(event.payload)
    })
    unlistenReplayReset = await bridge.listen<WorkspaceEventReplayResetPayload>("desktop:event-replay-reset", (event) => {
      if (closed || !event.payload) return
      if (expectedGeneration === null) queuePending({ type: "reset", payload: event.payload })
      else handleReplayResetPayload(event.payload)
    })
    const result = await bridge.invoke<DesktopEventsStartResult>("desktop_events_start", {
      request: { ...options, lastEventId: cursor.read() },
    })
    if (!result?.started || result.generation === undefined || result.leaseId === undefined) {
      throw new Error(result?.reason ?? "desktop event transport unavailable")
    }
    expectedGeneration = result.generation
    leaseId = result.leaseId
    if (result.lastEventId) cursor.commit(result.lastEventId)
    flushPending()
  } catch (error) {
    unlistenBatch()
    unlistenStatus()
    unlistenReplayReset()
    if (leaseId !== undefined) {
      try {
        await bridge.invoke("desktop_events_stop", { leaseId })
      } catch (stopError) {
        log.warn("Failed to stop native desktop event transport after startup failure", stopError)
      }
    }
    throw error
  }

  return {
    disconnect() {
      if (closed) {
        return
      }

      closed = true
      unlistenBatch()
      unlistenStatus()
      unlistenReplayReset()
      void bridge.invoke("desktop_events_stop", { leaseId }).catch((error) => {
        log.warn("Failed to stop native desktop event transport", error)
      })
    },
  }
}
