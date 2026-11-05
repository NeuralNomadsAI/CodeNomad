import type { WorkspaceManager } from "../workspaces/manager"
import { createInstanceClient } from "../workspaces/instance-client"
import type { AutoAcceptReply, PermissionReplier } from "./auto-accept-manager"
import type { PermissionReceipts } from "./receipts"

interface OpencodeReplierDeps {
  workspaceManager: WorkspaceManager
  permissionReceipts?: PermissionReceipts
}

/**
 * Default {@link PermissionReplier} that calls the OpenCode instance via the
 * native Promise client, using the same `"once"` reply the UI previously sent.
 */
export function createOpencodePermissionReplier(deps: OpencodeReplierDeps): PermissionReplier {
  return async (reply: AutoAcceptReply) => {
    const signal = deps.workspaceManager.requireWorkspaceCapability(reply.instanceId, "yolo")
    // prototype-1236: an explicit server replies on its own connection; receipts stay a local history feature.
    const receipts = deps.workspaceManager.isExplicitWorkspace?.(reply.instanceId) ? undefined : deps.permissionReceipts
    const connection = receipts ? await deps.workspaceManager.getSharedServiceConnection(reply.instanceId) : undefined
    const client = connection?.client ?? await createInstanceClient(deps.workspaceManager, reply.instanceId)
    if (!client) {
      throw new Error(`Yolo: instance ${reply.instanceId} is not ready`)
    }

    signal.throwIfAborted()
    const session = await client.session.get({ sessionID: reply.sessionId })
    if (!(await deps.workspaceManager.ownsLocation(reply.instanceId, session.location))) {
      throw new Error(`Yolo: session ${reply.sessionId} does not belong to workspace ${reply.instanceId}`)
    }

    signal.throwIfAborted()
    const confirm = connection && await receipts?.prepare(reply.instanceId, connection,
      reply.sessionId, reply.permissionId, "once", "yolo")
    connection?.assertCurrent()
    signal.throwIfAborted()
    deps.workspaceManager.requireWorkspaceCapability(reply.instanceId, "yolo")
    try {
      await client.permission.reply({
        sessionID: reply.sessionId,
        requestID: reply.permissionId,
        decision: "once",
      })
    } catch {
      // Dispatch may have succeeded even when its response was lost. A later
      // duplicate event/toggle must not replay this native mutation.
      throw Object.assign(new Error("Yolo permission reply failed after dispatch"), { retryable: false })
    }
    await confirm?.()
  }
}
