import type { InstanceStreamStatus } from "../../../server/src/api-types"

export type ConnectionStatus = InstanceStreamStatus

export type WorkspaceEventTransportStatus = "connecting" | "connected" | "disconnected"

export function deriveDisplayConnectionStatus(
  instanceStatus: ConnectionStatus | null,
  workspaceTransportStatus: WorkspaceEventTransportStatus,
): ConnectionStatus | null {
  if (instanceStatus === "disconnected" || instanceStatus === "error") {
    return instanceStatus
  }

  if (workspaceTransportStatus !== "connected") {
    return "connecting"
  }

  return instanceStatus
}
