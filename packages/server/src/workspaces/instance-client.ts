import type { OpenCodeClient } from "@opencode-ai/client"
import type { WorkspaceManager } from "./manager"

/**
 * Returns the shared native OpenCode client when the logical workspace is ready.
 * Session APIs resolve their location from the session itself.
 */
export async function createInstanceClient(
  workspaceManager: WorkspaceManager,
  instanceId: string,
): Promise<OpenCodeClient | null> {
  if (!workspaceManager.get(instanceId)) return null
  return workspaceManager.getSharedServiceClient()
}
