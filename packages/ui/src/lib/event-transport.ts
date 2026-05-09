import type { WorkspaceEventPayload } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import {
  resolveDesktopEventTransportStartOptions,
  type DesktopEventTransportStartOptions,
} from "./event-transport-contract"
import { readUseTauriNativeEventTransportPreference } from "./desktop-event-transport-preference"
import { getLogger } from "./logger"
import { runtimeEnv } from "./runtime-env"
import { connectTauriWorkspaceEvents } from "./native/desktop-events"

const log = getLogger("sse")
const FORCE_BROWSER_TRANSPORT_STORAGE_KEY = "perf242-force-browser-events"

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

function shouldForceBrowserTransport(): boolean {
  if (typeof window === "undefined") return false
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get("forceBrowserEvents") === "1") {
      return true
    }
    return window.localStorage?.getItem(FORCE_BROWSER_TRANSPORT_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

export async function connectWorkspaceEvents(
  callbacks: WorkspaceEventTransportCallbacks,
  options?: DesktopEventTransportStartOptions,
): Promise<WorkspaceEventConnection> {
  const nativeDesktopTransportEnabled = readUseTauriNativeEventTransportPreference()

  if (runtimeEnv.host === "tauri" && nativeDesktopTransportEnabled && !shouldForceBrowserTransport()) {
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
  } else if (runtimeEnv.host === "tauri") {
    log.info(
      nativeDesktopTransportEnabled
        ? "Event transport: browser-eventsource forced by localStorage override"
        : "Event transport: browser-eventsource forced by settings",
    )
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
