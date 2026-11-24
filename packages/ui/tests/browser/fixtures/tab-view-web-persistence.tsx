import { createRoot } from "solid-js"
import { initializeClientState, flushClientState, loadedRestorableSession } from "../../../src/stores/client-state"
import { addInstance, instances, waitForInitialWorkspaceLoad } from "../../../src/stores/instances"
import { attachInstanceTab, closeInstanceTab } from "../../../src/stores/app-tabs"
import { getTabViewState } from "../../../src/stores/tab-view-state"
import { getSessionPreview, openSessionPreview, restoreSessionPreview, showSessionChatFor, updateSessionPreviewHistory, updateSessionPreviewViewport } from "../../../src/stores/session-previews"
import { useAppSessionCapture } from "../../../src/lib/hooks/use-app-session-capture"
import { serverApi } from "../../../src/lib/api-client"
import { serverEvents } from "../../../src/lib/server-events"
import { savedSessionBrowser } from "../../../src/stores/session-browser-persistence"
import { readClientLayoutValue } from "../../../src/stores/client-state"
import { SESSION_BROWSER_STATE_KEY } from "../../../src/stores/tab-view-state-codec"

// Exercise the layout fallback when a browser refuses session storage.
// The harness's inventory and reload controls keep their separate storage access.
const sessionStore = window.sessionStorage
Object.defineProperty(window, "sessionStorage", { configurable: true, get() {
  throw new DOMException("Storage unavailable", "SecurityError")
} })
try { await initializeClientState() }
finally { Object.defineProperty(window, "sessionStorage", { configurable: true, value: sessionStore }) }
await waitForInitialWorkspaceLoad()
function add(id: string) {
  addInstance({ id, folder: "/same", port: 0, pid: 0, proxyPath: "", status: "ready" })
  attachInstanceTab(id)
}
for (const id of JSON.parse(sessionStorage.getItem("workspace-inventory") ?? '["web-a","web-b"]')) add(id)
let created = 0
serverApi.createPreview = async ({ sessionId, url }) => ({
  sessionId, targetUrl: url, token: `web-${++created}`, proxyUrl: url, createdAt: new Date().toISOString(),
})
serverApi.deletePreview = async () => {}
createRoot(() => { const capture = useAppSessionCapture(); capture.start() })
;(window as any).fixture = {
  open: openSessionPreview, restore: restoreSessionPreview, hide: showSessionChatFor,
  view: getTabViewState, preview: getSessionPreview, flush: flushClientState,
  saved: savedSessionBrowser, browsers: () => JSON.parse(readClientLayoutValue(SESSION_BROWSER_STATE_KEY) ?? "{}"),
  state: loadedRestorableSession, created: () => created,
  history: updateSessionPreviewHistory, viewport: updateSessionPreviewViewport,
  close: closeInstanceTab,
  add, ids: () => [...instances().keys()],
  removed: (workspaceId: string) => (serverEvents as any).dispatchBatch([{ type: "workspace.stopped", workspaceId, reason: "deleted" }]),
}
