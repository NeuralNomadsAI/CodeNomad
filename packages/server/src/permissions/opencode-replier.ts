import type { WorkspaceManager } from "../workspaces/manager"
import type { Logger } from "../logger"
import { fetch } from "undici"
import type { AutoAcceptReply, PermissionReplier } from "./auto-accept-manager"

const INSTANCE_HOST = "127.0.0.1"

interface OpencodeReplierDeps {
  workspaceManager: WorkspaceManager
  logger: Logger
}

/**
 * Default {@link PermissionReplier} that calls the OpenCode instance directly
 * over loopback using the same `"once"` reply the UI previously sent.
 *
 *   - v2:  POST /session/{sessionID}/permissions/{permissionID}  body { response }
 *   - legacy: POST /permission/{requestID}/reply                 body { reply }
 *
 * Mirrors the per-instance direct-call pattern used by the background-process
 * notifier (`background-processes/manager.ts`).
 */
export function createOpencodePermissionReplier(deps: OpencodeReplierDeps): PermissionReplier {
  return async (reply: AutoAcceptReply) => {
    const port = deps.workspaceManager.getInstancePort(reply.instanceId)
    if (!port) {
      throw new Error(`Yolo: instance ${reply.instanceId} has no open port`)
    }

    const headers: Record<string, string> = { "content-type": "application/json" }
    const authorization = deps.workspaceManager.getInstanceAuthorizationHeader(reply.instanceId)
    if (authorization) {
      headers.authorization = authorization
    }

    const url =
      reply.source === "v2"
        ? `http://${INSTANCE_HOST}:${port}/session/${encodeURIComponent(reply.sessionId)}/permissions/${encodeURIComponent(reply.permissionId)}`
        : `http://${INSTANCE_HOST}:${port}/permission/${encodeURIComponent(reply.permissionId)}/reply`

    const body =
      reply.source === "v2"
        ? JSON.stringify({ response: reply.reply })
        : JSON.stringify({ reply: reply.reply })

    const response = await fetch(url, { method: "POST", headers, body })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(
        `Yolo reply failed (${reply.source}): ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`,
      )
    }
  }
}
