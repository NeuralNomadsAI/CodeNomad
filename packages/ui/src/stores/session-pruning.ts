import type { SessionMessageInfo } from "@opencode-ai/client"
import { contentRevision } from "../../../server/src/opencode/session-pruning/revision"
import { serverApi } from "../lib/api-client"
import { tGlobal } from "../lib/i18n"
import { getRootClient } from "./opencode-client"

export async function pruneMessageContent(
  instanceId: string, sessionId: string,
  message: Extract<SessionMessageInfo, { type: "assistant" }>, indexes: number[],
): Promise<SessionMessageInfo> {
  const result = await serverApi.pruneSessionMessage(instanceId, {
    sessionID: sessionId, messageID: message.id, indexes,
    revision: await contentRevision(message.content),
  })
  if (result.status !== "pruned") throw new Error(tGlobal("session.pruning.blocked"))
  // Never project a client-generated remainder or a plugin's message snapshot.
  // Re-read the native history after commit (and after future RPC invalidations).
  return getRootClient(instanceId).session.message({ sessionID: sessionId, messageID: message.id })
}
