import { sdkManager, type OpenCodeClient } from "../lib/sdk-manager"
import { activeInstanceId } from "./instances"

function buildRootProxyPath(instanceId: string): string {
  return `/workspaces/${encodeURIComponent(instanceId)}/instance`
}

function getRootClient(instanceId: string): OpenCodeClient {
  return sdkManager.createClient(instanceId, buildRootProxyPath(instanceId), () => activeInstanceId() === instanceId)
}

export { buildRootProxyPath, getRootClient, type OpenCodeClient }
