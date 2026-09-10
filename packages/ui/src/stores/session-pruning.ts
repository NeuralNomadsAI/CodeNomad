import type { SessionMessageInfo } from "@opencode-ai/client"
import { contentRevision } from "../../../server/src/opencode/session-pruning/revision"
import { serverApi } from "../lib/api-client"
import { tGlobal } from "../lib/i18n"
import { getRootClient } from "./opencode-client"
import { getOpenCodeInstanceGeneration, getOpenCodeMutationRevision, invalidateOpenCodeSessionContent } from "./opencode-data"
import { invalidateSessionMessageLoad } from "./session-state"

export async function pruneMessageContent(
  instanceId: string, sessionId: string,
  message: Extract<SessionMessageInfo, { type: "assistant" }>, indexes: number[],
  apply: (message: SessionMessageInfo) => void,
): Promise<void> {
  const client = getRootClient(instanceId)
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const result = await serverApi.pruneSessionMessage(instanceId, {
    sessionID: sessionId, messageID: message.id, indexes,
    revision: await contentRevision(message.content),
  })
  if (result.status !== "pruned") throw new Error(tGlobal("session.pruning.blocked"))
  // Never project a client-generated remainder or a plugin's message snapshot.
  // Re-read the native history after commit (and after future RPC invalidations).
  invalidateOpenCodeSessionContent(instanceId, sessionId)
  invalidateSessionMessageLoad(instanceId, sessionId)
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = getOpenCodeMutationRevision(instanceId, sessionId)
    const updated = await client.session.message({ sessionID: sessionId, messageID: message.id })
    if (generation !== getOpenCodeInstanceGeneration(instanceId) || client !== getRootClient(instanceId)) break
    if (revision !== getOpenCodeMutationRevision(instanceId, sessionId)) continue
    // Apply in the same synchronous turn as the authority check: an older
    // response cannot overtake another client's pruning invalidation.
    apply(updated)
    return
  }
  throw new Error(tGlobal("session.pruning.blocked"))
}
