import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

import { serverApi } from "../lib/api-client"
import { OpencodeApiError, requestData } from "../lib/opencode-api"
import { getLogger } from "../lib/logger"

const log = getLogger("api")

function shouldFallbackToSessionExport(error: unknown): boolean {
  if (!(error instanceof OpencodeApiError)) {
    return false
  }

  const cause = (error as any).cause
  const causeData = cause && typeof cause === "object" ? (cause as any).data : undefined
  const message = typeof causeData?.message === "string" ? causeData.message : ""
  return causeData?.kind === "Body" && message.includes("Missing key")
}

export async function fetchSessionMessages(instanceId: string, sessionId: string, client: OpencodeClient): Promise<any[]> {
  try {
    return await requestData<any[]>(
      client.session.messages({ sessionID: sessionId }),
      "session.messages",
    )
  } catch (error) {
    if (!shouldFallbackToSessionExport(error)) {
      throw error
    }

    log.warn("Falling back to opencode export for malformed session messages", { instanceId, sessionId, error })
    const exported = await serverApi.exportSessionData(instanceId, sessionId)
    return Array.isArray(exported.messages) ? exported.messages : []
  }
}
