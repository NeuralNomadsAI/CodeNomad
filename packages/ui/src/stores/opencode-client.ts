import type { OpenCodeClient } from "../lib/sdk-manager"
import { backendOf } from "../lib/backend-client"
import { parseInstanceKey } from "../lib/backend-identity"
import { activeInstanceId } from "./instances"

function buildRootProxyPath(instanceId: string): string {
  return `/workspaces/${encodeURIComponent(parseInstanceKey(instanceId).workspaceId)}/instance`
}

function getRootClient(instanceId: string): OpenCodeClient {
  return backendOf(instanceId).sdk.createClient(instanceId, buildRootProxyPath(instanceId), () => activeInstanceId() === instanceId)
}

export { buildRootProxyPath, getRootClient, type OpenCodeClient }
