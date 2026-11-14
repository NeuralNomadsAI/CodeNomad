import { createRoot } from "solid-js"
import { initializeClientState, flushClientState, loadedRestorableSession } from "../../../src/stores/client-state"
import { addInstance, waitForInitialWorkspaceLoad } from "../../../src/stores/instances"
import { attachInstanceTab, closeInstanceTab } from "../../../src/stores/app-tabs"
import { getTabViewState } from "../../../src/stores/tab-view-state"
import { getSessionPreview, openSessionPreview, restoreSessionPreview, showSessionChatFor, updateSessionPreviewHistory, updateSessionPreviewViewport } from "../../../src/stores/session-previews"
import { useAppSessionCapture } from "../../../src/lib/hooks/use-app-session-capture"
import { serverApi } from "../../../src/lib/api-client"

await initializeClientState()
await waitForInitialWorkspaceLoad()
for (const id of ["web-a", "web-b"]) {
  addInstance({ id, folder: "/same", port: 0, pid: 0, proxyPath: "", status: "ready" })
  attachInstanceTab(id)
}
let created = 0
serverApi.createPreview = async ({ sessionId, url }) => ({
  sessionId, targetUrl: url, token: `web-${++created}`, proxyUrl: url, createdAt: new Date().toISOString(),
})
serverApi.deletePreview = async () => {}
createRoot(() => { const capture = useAppSessionCapture(); capture.start() })
;(window as any).fixture = {
  open: openSessionPreview, restore: restoreSessionPreview, hide: showSessionChatFor,
  view: getTabViewState, preview: getSessionPreview, flush: flushClientState,
  state: loadedRestorableSession, created: () => created,
  history: updateSessionPreviewHistory, viewport: updateSessionPreviewViewport,
  close: closeInstanceTab,
}
