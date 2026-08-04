import type { WorkspaceEventPayload } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import {
  resolveDesktopEventTransportStartOptions,
  type DesktopEventTransportStartOptions,
} from "./event-transport-contract"
import { readUseTauriNativeEventTransportPreference } from "./desktop-event-transport-preference"
import {
  acquireEventTransportCursorAuthority,
  type EventTransportCursorAuthority,
} from "./event-transport-cursor"
import { getLogger } from "./logger"
import { runtimeEnv } from "./runtime-env"
import { connectTauriWorkspaceEvents } from "./native/desktop-events"

const log = getLogger("sse")

export interface WorkspaceEventTransportCallbacks {
  onBatch: (events: WorkspaceEventPayload[]) => boolean | void
  onError?: () => void
  onOpen?: () => void
  onStatus?: (status: WorkspaceEventTransportStatus) => void
  onPing?: (payload: { ts?: number }) => void
  onReplayReset?: () => boolean | void
}

export type WorkspaceEventTransportStatus = "connecting" | "connected" | "disconnected"

export interface WorkspaceEventConnection {
  disconnect: () => void
}

async function connectBrowserWorkspaceEvents(
  callbacks: WorkspaceEventTransportCallbacks,
  cursor: EventTransportCursorAuthority,
): Promise<WorkspaceEventConnection> {
  const notifyDisconnected = () => {
    callbacks.onStatus?.("disconnected")
    callbacks.onError?.()
  }
  const source = serverApi.connectEvents({
    onEvent: (event) => callbacks.onBatch([event]),
    onError: notifyDisconnected,
    onOpen: () => {
      callbacks.onStatus?.("connected")
      callbacks.onOpen?.()
    },
    onPing: callbacks.onPing,
    onReplayReset: callbacks.onReplayReset,
    getLastEventId: cursor.read,
    onEventId: cursor.commit,
  })
  callbacks.onStatus?.("connecting")
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
  const cursor = acquireEventTransportCursorAuthority()
  const nativeDesktopTransportEnabled = readUseTauriNativeEventTransportPreference()

  if (
    runtimeEnv.host === "tauri" &&
    runtimeEnv.windowContext === "local" &&
    nativeDesktopTransportEnabled
  ) {
    try {
      const conn = await connectTauriWorkspaceEvents(
        callbacks,
        resolveDesktopEventTransportStartOptions(options),
        undefined,
        cursor,
      )
      log.info("Event transport: rust-native (desktop_event_transport)")
      return conn
    } catch (error) {
      log.warn("Failed to start native desktop event transport, falling back to browser EventSource", error)
    }
  } else if (runtimeEnv.host === "tauri" && runtimeEnv.windowContext === "remote") {
    log.info("Event transport: browser-eventsource forced for remote Tauri window")
  } else if (runtimeEnv.host === "tauri") {
    log.info("Event transport: browser-eventsource forced by settings")
  }

  log.info(`Event transport: browser-eventsource (host=${runtimeEnv.host})`)
  return connectBrowserWorkspaceEvents(callbacks, cursor)
}

export type {
  DesktopEventsStartResult,
  DesktopEventTransportReconnectPolicy,
  DesktopEventTransportStartOptions,
  DesktopEventTransportState,
  DesktopEventTransportStatusPayload,
} from "./event-transport-contract"
