import type { WorkspaceEventPayload } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import {
  resolveDesktopEventTransportStartOptions,
  type DesktopEventTransportStartOptions,
} from "./event-transport-contract"
import { getLogger } from "./logger"
import { runtimeEnv } from "./runtime-env"
import { connectTauriWorkspaceEvents } from "./native/desktop-events"

const log = getLogger("sse")

export interface WorkspaceEventTransportCallbacks {
  onBatch: (events: WorkspaceEventPayload[]) => void
  onError?: () => void
  onOpen?: () => void
  onPing?: (payload: { ts?: number }) => void
}

export interface WorkspaceEventConnection {
  disconnect: () => void
}

async function connectBrowserWorkspaceEvents(
  callbacks: WorkspaceEventTransportCallbacks,
): Promise<WorkspaceEventConnection> {
  const source = serverApi.connectEvents((event) => {
    callbacks.onBatch([event])
  }, callbacks.onError, callbacks.onPing)
  source.onopen = () => callbacks.onOpen?.()
  return {
    disconnect() {
      source.close()
    },
  }
}

export async function connectWorkspaceEvents(
  callbacks: WorkspaceEventTransportCallbacks,
  options?: DesktopEventTransportStartOptions,
): Promise<WorkspaceEventConnection> {
  if (runtimeEnv.host === "tauri") {
    try {
      const conn = await connectTauriWorkspaceEvents(
        callbacks,
        resolveDesktopEventTransportStartOptions(options),
      )
      ;(globalThis as any).__TRANSPORT_TYPE = "rust-native"
      log.info("Event transport: rust-native (desktop_event_transport)")
      return conn
    } catch (error) {
      log.warn("Failed to start native desktop event transport, falling back to browser EventSource", error)
    }
  }

  ;(globalThis as any).__TRANSPORT_TYPE = "browser-eventsource"
  log.info(`Event transport: browser-eventsource (host=${runtimeEnv.host})`)
  return connectBrowserWorkspaceEvents(callbacks)
}

export type {
  DesktopEventsStartResult,
  DesktopEventTransportReconnectPolicy,
  DesktopEventTransportStartOptions,
  DesktopEventTransportState,
  DesktopEventTransportStatusPayload,
} from "./event-transport-contract"
