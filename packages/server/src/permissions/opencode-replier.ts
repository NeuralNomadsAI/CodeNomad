import type { WorkspaceManager } from "../workspaces/manager"
import type { Logger } from "../logger"
import { resolveNativeSessionScope } from "../workspaces/native-session-scope"
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
 * Resolves the session's current native location immediately before replying.
 */
export function createOpencodePermissionReplier(deps: OpencodeReplierDeps): PermissionReplier {
  return async (reply: AutoAcceptReply) => {
    const { client, workspace } = await resolveNativeSessionScope(deps.workspaceManager, reply.instanceId, reply.sessionId)

    const opts = { throwOnError: true } as const

    if (reply.source === "v2") {
      await client.v2.session.permission.reply(
        {
          sessionID: reply.sessionId,
          requestID: reply.permissionId,
          reply: reply.reply,
          ...(workspace ? { workspace } : {}),
        },
        opts,
      )
    } else {
      await client.permission.reply(
        {
          requestID: reply.permissionId,
          reply: reply.reply,
          ...(workspace ? { workspace } : {}),
        },
        opts,
      )
    }
  }
}
