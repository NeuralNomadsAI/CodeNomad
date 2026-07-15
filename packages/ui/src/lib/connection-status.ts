import type { InstanceStreamStatus } from "../../../server/src/api-types"
import type { WorkspaceEventTransportStatus } from "./event-transport"

export type ConnectionStatus = InstanceStreamStatus

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
