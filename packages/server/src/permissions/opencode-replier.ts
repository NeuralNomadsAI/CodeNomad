import type { WorkspaceManager } from "../workspaces/manager"
import { createInstanceClient } from "../workspaces/instance-client"
import type { AutoAcceptReply, PermissionReplier } from "./auto-accept-manager"

interface OpencodeReplierDeps {
  workspaceManager: WorkspaceManager
}

/**
 * Default {@link PermissionReplier} that calls the OpenCode instance via the
 * native Promise client, using the same `"once"` reply the UI previously sent.
 */
export function createOpencodePermissionReplier(deps: OpencodeReplierDeps): PermissionReplier {
  return async (reply: AutoAcceptReply) => {
    const client = await createInstanceClient(deps.workspaceManager, reply.instanceId)
    if (!client) {
      throw new Error(`Yolo: instance ${reply.instanceId} is not ready`)
    }

    const session = await client.session.get({ sessionID: reply.sessionId })
    if (!(await deps.workspaceManager.ownsDirectory(reply.instanceId, session.location.directory))) {
      throw new Error(`Yolo: session ${reply.sessionId} does not belong to workspace ${reply.instanceId}`)
    }

    await client.permission.reply({
      sessionID: reply.sessionId,
      requestID: reply.permissionId,
      reply: "once",
    })
  }
}
