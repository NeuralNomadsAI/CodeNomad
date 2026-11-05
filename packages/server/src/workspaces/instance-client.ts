import type { OpenCodeClient } from "@opencode/client"
import type { WorkspaceManager } from "./manager"

/**
 * Returns the connection pinned to the published logical workspace.
 * Session APIs resolve their location from the session itself.
 */
export async function createInstanceClient(
  workspaceManager: WorkspaceManager,
  instanceId: string,
): Promise<OpenCodeClient | null> {
  return (await workspaceManager.getSharedServiceConnection(instanceId))?.client ?? null
}
