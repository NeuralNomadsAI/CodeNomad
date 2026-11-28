import type { WorkspaceEventPayload } from "../../../server/src/api-types"
import { serverApi, type ServerApi } from "./api-client"

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
  api: Pick<ServerApi, "connectEvents"> = serverApi,
): Promise<WorkspaceEventConnection> {
  const notifyDisconnected = () => {
    callbacks.onStatus?.("disconnected")
    callbacks.onError?.()
  }
  const source = api.connectEvents((event) => {
    callbacks.onBatch([event])
  }, notifyDisconnected, callbacks.onPing)
  source.onopen = () => {
    callbacks.onStatus?.("connected")
    callbacks.onOpen?.()
  }
  return {
    disconnect() {
      source.close()
    },
  }
}
