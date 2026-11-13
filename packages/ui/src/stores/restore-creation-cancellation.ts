import { serverApi } from "../lib/api-client"
import { retryWithBackoff } from "../lib/retry-utils"

export function cancelRestoreCreation(requestId: string, api: Pick<typeof serverApi, "cancelWorkspaceCreation"> = serverApi): Promise<void> {
  return retryWithBackoff(() => api.cancelWorkspaceCreation(requestId), {
    maxAttempts: 4,
    initialDelayMs: 250,
    maxDelayMs: 2_000,
    backoffMultiplier: 4,
  })
}
