import { nativeFixture } from "./browser-frame-native-bridge"
import { serverApi } from "../../../src/lib/api-client"
import { getSessionPreview, openSessionPreview, sessionPreviews } from "../../../src/stores/session-previews"
import { initializeClientState, writeClientLayoutValue } from "../../../src/stores/client-state"

// The production shell, session switching, preview store and native guests run
// unchanged. Only server responses and the native registration IPC are fixtures.
let nextToken = 0
serverApi.createPreview = async ({ sessionId, url }) => ({ sessionId, targetUrl: url,
  token: `preview-${++nextToken}`, proxyUrl: url, createdAt: new Date().toISOString() })
serverApi.deletePreview = async () => {}
if (new URLSearchParams(location.search).has("legacy")) {
  await initializeClientState()
  writeClientLayoutValue("opencode-session-previews-v1", JSON.stringify({
    "/repo": { targetUrl: `${location.origin}/page/legacy`, mode: "chat" },
  }))
}
await import("./header-windows")
const shell = (window as any).fixture
shell.addSession("second")
Object.assign(shell, {
  native: nativeFixture,
  openPreview: (sessionId: string, url: string, folder = "/repo") => openSessionPreview(sessionId, url, folder),
  preview: (sessionId: string, folder = "/repo") => getSessionPreview(sessionId, folder),
  previewCount: () => sessionPreviews().size,
})
;(window as any).browserHistoryReady = true
