import type { SessionMessageInfo } from "@opencode/client"
import { captureBackendOperation } from "../lib/backend-operation"
import { contentRevision } from "../../../server/src/opencode/session-pruning/revision"
import { backendOf } from "../lib/backend-client"
import { tGlobal } from "../lib/i18n"
import { getRootClient } from "./opencode-client"
import { getOpenCodeInstanceGeneration, getOpenCodeMutationRevision, invalidateOpenCodeSessionContent } from "./opencode-data"
import { invalidateSessionMessageLoad } from "./session-state"

export async function pruneMessageContent(
  instanceId: string, sessionId: string,
  message: Extract<SessionMessageInfo, { type: "assistant" }>, indexes: number[],
  apply: (message: SessionMessageInfo) => void,
  parentSignal?: AbortSignal,
): Promise<void> {
  const attachment = captureBackendOperation(instanceId)
  const { signal } = captureBackendOperation(instanceId, parentSignal)
  signal.throwIfAborted()
  const client = getRootClient(instanceId)
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const revision = await contentRevision(message.content)
  signal.throwIfAborted()
  if (generation !== getOpenCodeInstanceGeneration(instanceId) || client !== getRootClient(instanceId)) throw new Error(tGlobal("session.pruning.conflict"))
  const result = await backendOf(instanceId).api.pruneSessionMessage(instanceId, {
    sessionID: sessionId, messageID: message.id, indexes,
    revision,
  })
  if (result.status !== "pruned") throw new Error(tGlobal(`session.pruning.${result.reason}`))
  if (!attachment.current() || generation !== getOpenCodeInstanceGeneration(instanceId)) return
  // Never project a client-generated remainder or a plugin's message snapshot.
  // Re-read the native history after commit (and after future RPC invalidations).
  invalidateOpenCodeSessionContent(instanceId, sessionId)
  invalidateSessionMessageLoad(instanceId, sessionId)
  if (signal.aborted) return
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = getOpenCodeMutationRevision(instanceId, sessionId)
    signal.throwIfAborted()
    const updated = await client.session.message.get({ sessionID: sessionId, messageID: message.id }, { signal })
    if (signal.aborted || generation !== getOpenCodeInstanceGeneration(instanceId) || client !== getRootClient(instanceId)) break
    if (revision !== getOpenCodeMutationRevision(instanceId, sessionId)) continue
    // Apply in the same synchronous turn as the authority check: an older
    // response cannot overtake another client's pruning invalidation.
    apply(updated)
    return
  }
  throw new Error(tGlobal("session.pruning.blocked"))
}
