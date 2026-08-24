import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
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
import { getLogger } from "../logger"

const log = getLogger("sse")

interface WorkspaceEventBatchPayload {
  generation: number
  sequence: number
  emittedAt: number
  events: WorkspaceEventPayload[]
}

interface DesktopEventTransportBridge {
  invoke: typeof invoke
  listen: typeof listen
}

const defaultDesktopEventTransportBridge: DesktopEventTransportBridge = {
  invoke,
  listen,
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
): Promise<WorkspaceEventConnection> {
  let closed = false
  let opened = false
  let expectedGeneration: number | null = null
  const notifyTerminalError = createTerminalErrorNotifier(callbacks)
  const pendingBatches: WorkspaceEventBatchPayload[] = []
  const pendingStatuses: DesktopEventTransportStatusPayload[] = []

  const matchesGeneration = (generation: number) => expectedGeneration === generation

  const handleBatchPayload = (payload: WorkspaceEventBatchPayload) => {
    if (!payload || !matchesGeneration(payload.generation)) return

    if (!opened) {
      opened = true
      callbacks.onStatus?.("connected")
      callbacks.onOpen?.()
    }

    const events = payload.events ?? []
    if (events.length === 0) {
      return
    }

    callbacks.onBatch(events)
  }

  const handleStatusPayload = (payload: DesktopEventTransportStatusPayload) => {
    if (!payload || !matchesGeneration(payload.generation)) return

    callbacks.onStatus?.(mapDesktopEventTransportStatus(payload.state))

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

  const flushPending = () => {
    if (expectedGeneration === null) return
    for (const payload of pendingStatuses.splice(0, pendingStatuses.length)) {
      handleStatusPayload(payload)
    }
    for (const payload of pendingBatches.splice(0, pendingBatches.length)) {
      handleBatchPayload(payload)
    }
  }

  const unlistenBatch = await bridge.listen<WorkspaceEventBatchPayload>("desktop:event-batch", (event) => {
    if (closed) return
    const payload = event.payload
    if (!payload) return
    if (expectedGeneration === null) {
      pendingBatches.push(payload)
      return
    }
    handleBatchPayload(payload)
  })

  const unlistenStatus = await bridge.listen<DesktopEventTransportStatusPayload>("desktop:event-stream-status", (event) => {
    if (closed) return
    const payload = event.payload
    if (!payload) return
    if (expectedGeneration === null) {
      pendingStatuses.push(payload)
      return
    }
    handleStatusPayload(payload)
  })

  try {
    const result = await bridge.invoke<DesktopEventsStartResult>("desktop_events_start", { request: options })
    if (!result?.started) {
      throw new Error(result?.reason ?? "desktop event transport unavailable")
    }
    expectedGeneration = result.generation ?? null
    flushPending()
  } catch (error) {
    unlistenBatch()
    unlistenStatus()
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
      void bridge.invoke("desktop_events_stop").catch((error) => {
        log.warn("Failed to stop native desktop event transport", error)
      })
    },
  }
}
