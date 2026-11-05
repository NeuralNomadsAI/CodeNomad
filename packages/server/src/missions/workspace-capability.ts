import type { WorkspaceDescriptor } from "../api-types"
import type { WorkspaceManager } from "../workspaces/manager"

/** Bridge discovery is exclusively within the local service namespace. */
export function localMissionWorkspaces(manager: Pick<WorkspaceManager, "list">): WorkspaceDescriptor[] {
  return manager.list().filter(workspace => !workspace.binding || workspace.binding.serverId === "local-shared")
}
