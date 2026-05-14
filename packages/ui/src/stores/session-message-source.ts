import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

import { serverApi } from "../lib/api-client"
import { requestData } from "../lib/opencode-api"
import { getLogger } from "../lib/logger"
import { getExportedSessionMessages, isLegacyMissingAgentValidationError } from "./session-message-fallback"

const log = getLogger("api")

export async function fetchSessionMessages(
  instanceId: string,
  sessionId: string,
  worktreeSlug: string,
  client: OpencodeClient,
): Promise<any[]> {
  try {
    return await requestData<any[]>(
      client.session.messages({ sessionID: sessionId }),
      "session.messages",
    )
  } catch (error) {
    if (!isLegacyMissingAgentValidationError(error)) {
      throw error
    }

    log.warn("Falling back to opencode export for malformed session messages", { instanceId, sessionId, error })
    const exported = await serverApi.exportSessionData(instanceId, worktreeSlug, sessionId)
    return getExportedSessionMessages(exported) as any[]
  }
}
