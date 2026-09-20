import type { SessionMessageInfo, SessionMessagesResponse } from "@opencode/client"
import { navigationTargetSchema, type NavigationTarget } from "../../../server/src/opencode/session-pruning/navigation-contract"
import { serverApi } from "../lib/api-client"
import { tGlobal } from "../lib/i18n"
import type { MessageWindowState } from "./message-v2/message-window"

// CodeNomad cursors are explicitly namespaced and never sent to native APIs.
// Persist the stable target rather than a traversed path of page cursors.
const PREFIX = "codenomad:history-window:1:"
// Only a confirmed absent/hidden anchor can retire a saved reading position.
// Transport failures and ownership/revert conflicts retain retry semantics.
export class MissingHistoryAnchorError extends Error {
  constructor() { super(tGlobal("session.pruning.conflict")) }
}
export const historyWindowCursor = (target: NavigationTarget) => PREFIX + encodeURIComponent(JSON.stringify(target))
export function historyWindowTarget(cursor: string | undefined): NavigationTarget | undefined {
  if (!cursor?.startsWith(PREFIX)) return undefined
  return navigationTargetSchema.parse(JSON.parse(decodeURIComponent(cursor.slice(PREFIX.length))))
}

export async function readHistoryWindow(instanceId: string, sessionId: string, target: NavigationTarget, signal?: AbortSignal): Promise<{ response: SessionMessagesResponse; window: MessageWindowState }> {
  const result = await serverApi.fetchHistoryWindow(instanceId, sessionId, target, signal)
  signal?.throwIfAborted()
  if (result.status !== "window") {
    if (result.reason === "anchor_missing") throw new MissingHistoryAnchorError()
    throw new Error(tGlobal(`session.pruning.${result.reason}`))
  }
  return {
    // The isolated native regression compares every reconstructed message to
    // session.message.get/export, including provider state and metadata.
    response: { data: result.messages as SessionMessageInfo[], cursor: {} },
    window: { kind: result.latest ? "latest" : "history", resumeCursor: historyWindowCursor(result.resume),
      olderCursor: result.older ? historyWindowCursor(result.older) : undefined,
      newerCursors: [result.newer ? historyWindowCursor(result.newer) : null] },
  }
}
