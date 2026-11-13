import type { WorkspaceManager } from "../../workspaces/manager"
import type { OpenCodeClient } from "@opencode/client"

/** Stable workspace/Location/connection identities for the legacy route oracles. */
export function brokerIdentities(directory = "/repo") {
  const location = { directory }
  const workspace = { id: "fixture", path: directory } as ReturnType<WorkspaceManager["get"]>
  return { get: () => workspace, getServiceLocation: () => location, getWorktreeIdentityForPath: async () => directory }
}

export function brokerConnection(client: OpenCodeClient) {
  const connection = { client, assertCurrent() {} }
  return { getSharedServiceConnection: async () => connection as any, getSharedServiceClient: async () => client }
}
