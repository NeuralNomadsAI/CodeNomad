import { createEffect, onCleanup } from "solid-js"
import { serverApi } from "./api-client"
import { LOCAL_BACKEND_ID, parseInstanceKey } from "./backend-identity"
import { generateUUID } from "./client-identity"
import { getLogger } from "./logger"
import { browserHostCapabilities } from "./native/browser"
import { runtimeEnv } from "./runtime-env"

const RENEW_MS = 15_000
const log = getLogger("api")

/**
 * While a local desktop view shows a session, its preview is the session's browser for OpenCode's native
 * browser tools. The local server renews the attachment on each hold and drops it once no view holds it.
 */
export function holdNativeBrowser(instanceId: () => string, sessionId: () => string, active: () => boolean): void {
  if (!browserHostCapabilities(runtimeEnv).automation) return
  createEffect(() => {
    const { backendId, workspaceId } = parseInstanceKey(instanceId())
    const session = sessionId()
    if (!active() || backendId !== LOCAL_BACKEND_ID || !session) return
    const holdId = generateUUID()
    const renew = () => serverApi.holdNativeBrowser(holdId, { workspaceId, sessionId: session })
      .catch(error => log.warn("Native browser hold failed", error))
    void renew()
    const timer = setInterval(renew, RENEW_MS)
    onCleanup(() => {
      clearInterval(timer)
      void serverApi.releaseNativeBrowser(holdId).catch(() => undefined)
    })
  })
}
