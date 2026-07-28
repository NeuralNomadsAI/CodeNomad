import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { WorkspaceManager } from "./manager"

const INSTANCE_HOST = "127.0.0.1"
const LOOPBACK_TIMEOUT_MS = 10_000

interface InstanceClientOptions {
  timeoutMs?: number
}

/**
 * Creates an OpenCode SDK client for direct loopback communication with a
 * running workspace instance.
 *
 * Routes and body shapes come from the auto-generated SDK contract
 * (`@opencode-ai/sdk`), eliminating handwritten URL construction that can
 * drift between SDK versions. Other server modules that need to call the
 * OpenCode instance directly should use this factory rather than building
 * `http://127.0.0.1:{port}/...` URLs by hand.
 *
 * All requests carry a 10-second timeout — loopback calls should be
 * near-instant; a hang indicates a stuck instance.
 *
 * The client is cheap to create (object only, no connection); create one per
 * call or cache per instance as needed. Returns `null` when the instance has
 * no open port yet.
 */
export function createInstanceClient(
  workspaceManager: WorkspaceManager,
  instanceId: string,
  options: InstanceClientOptions = {},
): OpencodeClient | null {
  const port = workspaceManager.getInstancePort(instanceId)
  if (!port) return null

  const headers: Record<string, string> = {}
  const authorization = workspaceManager.getInstanceAuthorizationHeader(instanceId)
  if (authorization) {
    headers.authorization = authorization
  }

  const workspace = workspaceManager.get(instanceId)
  const timeoutMs = options.timeoutMs ?? LOOPBACK_TIMEOUT_MS

  return createOpencodeClient({
    baseUrl: `http://${INSTANCE_HOST}:${port}/`,
    headers,
    fetch: (url, init) => fetch(url, {
      ...(init as RequestInit),
      signal: AbortSignal.any([
        ...(url instanceof Request ? [url.signal] : []),
        ...((init as RequestInit | undefined)?.signal ? [(init as RequestInit).signal!] : []),
        AbortSignal.timeout(timeoutMs),
      ]),
    }),
    ...(workspace?.path ? { directory: workspace.path } : {}),
  })
}
