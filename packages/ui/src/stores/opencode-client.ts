import { sdkManager, type OpencodeClient } from "../lib/sdk-manager"

function buildRootProxyPath(instanceId: string): string {
  return `/workspaces/${encodeURIComponent(instanceId)}/instance`
}

function getRootClient(instanceId: string): OpencodeClient {
  return sdkManager.createClient(instanceId, buildRootProxyPath(instanceId))
}

export { buildRootProxyPath, getRootClient }
