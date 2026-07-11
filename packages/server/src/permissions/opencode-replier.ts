import type { WorkspaceManager } from "../workspaces/manager"
import type { Logger } from "../logger"
import { createInstanceClient } from "../workspaces/instance-client"
import type { AutoAcceptReply, PermissionReplier } from "./auto-accept-manager"

interface OpencodeReplierDeps {
  workspaceManager: WorkspaceManager
  logger: Logger
}

/**
 * Default {@link PermissionReplier} that calls the OpenCode instance via the
 * generated SDK client over loopback, using the same `"once"` reply the UI
 * previously sent.
 *
 * Uses `createInstanceClient` so routes and body shapes are always correct
 * for the installed SDK version — no hand-assembled URLs.
 */
export function createOpencodePermissionReplier(deps: OpencodeReplierDeps): PermissionReplier {
  return async (reply: AutoAcceptReply) => {
    const client = createInstanceClient(deps.workspaceManager, reply.instanceId)
    if (!client) {
      throw new Error(`Yolo: instance ${reply.instanceId} has no open port`)
    }

    const opts = { throwOnError: true } as const

    if (reply.source === "v2") {
      await client.v2.session.permission.reply(
        {
          sessionID: reply.sessionId,
          requestID: reply.permissionId,
          reply: reply.reply,
        },
        opts,
      )
    } else {
      await client.permission.reply(
        {
          requestID: reply.permissionId,
          reply: reply.reply,
        },
        opts,
      )
    }
  }
}
