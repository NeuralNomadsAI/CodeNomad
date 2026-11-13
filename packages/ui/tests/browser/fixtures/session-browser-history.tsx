import { nativeFixture } from "./browser-frame-native-bridge"
import { serverApi } from "../../../src/lib/api-client"
import { getSessionPreview, openSessionPreview, sessionPreviews } from "../../../src/stores/session-previews"
import { initializeClientState, writeClientLayoutValue } from "../../../src/stores/client-state"
import { createEffect, createRoot } from "solid-js"
import { getTabViewState, seedTabViewState } from "../../../src/stores/tab-view-state"
import { migrateLegacyTabPreviews } from "../../../src/stores/tab-view-state-migration"
import { publishInstanceLifecycleAuthority } from "../../../src/stores/instance-lifecycle-authority"
import { removeInstance } from "../../../src/stores/instances"

// The production shell, session switching, preview store and native guests run
// unchanged. Only server responses and the native registration IPC are fixtures.
let nextToken = 0
const deletedPreviews: string[] = []
let delayedPreview: { url: string; requested: boolean; promise: Promise<void>; release: () => void } | undefined
serverApi.createPreview = async ({ sessionId, url }) => {
  const delay = delayedPreview
  if (delay?.url === url && !delay.requested) {
    delay.requested = true
    await delay.promise
    delayedPreview = undefined
  }
  return { sessionId, targetUrl: url, token: `preview-${++nextToken}`, proxyUrl: url, createdAt: new Date().toISOString() }
}
serverApi.deletePreview = async token => { deletedPreviews.push(token) }
await initializeClientState()
const ids = ["header-windows", "header-duplicate"]
// This standalone shell fixture has no App capture hook; serialize its actual
// occurrence envelopes at the same persistence boundary as workspace descriptors.
for (const id of ids) {
  const saved = localStorage.getItem(`fixture-tab-view-${id}`)
  if (saved) seedTabViewState(id, JSON.parse(saved))
}
if (new URLSearchParams(location.search).has("legacy")) {
  const legacy = JSON.stringify({
    "/repo": { targetUrl: `${location.origin}/page/legacy`, mode: "chat" },
  })
  const migrated = migrateLegacyTabPreviews({ activeTabIndex: 0, tabs: [
    { kind: "workspace", folder: "/repo", occurrence: 0, activeSessionId: "session",
      drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} },
  ] }, legacy)!
  seedTabViewState(ids[0], (migrated.state.tabs[0] as any).viewState)
  writeClientLayoutValue("opencode-session-previews-v1", migrated.remaining)
}
createRoot(() => { for (const id of ids) createEffect(() => localStorage.setItem(`fixture-tab-view-${id}`, JSON.stringify(getTabViewState(id)))) })
await import("./header-windows")
const shell = (window as any).fixture
shell.addSession("second")
Object.assign(shell, {
  native: nativeFixture,
  openPreview: (sessionId: string, url: string, instanceId = ids[0]) => openSessionPreview(sessionId, url, instanceId),
  preview: (sessionId: string, instanceId = ids[0]) => getSessionPreview(sessionId, instanceId),
  savedPreview: (sessionId: string, instanceId = ids[0]) => getTabViewState(instanceId).previews?.[sessionId],
  closeOccurrence: (instanceId: string) => {
    publishInstanceLifecycleAuthority({ type: "removed", instanceId, folder: "/repo", occurrence: ids.indexOf(instanceId) })
    removeInstance(instanceId)
  },
  previewCount: () => sessionPreviews().size,
  deletedPreviews,
  delayPreview: (url: string) => {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    delayedPreview = { url, requested: false, promise, release }
  },
  isPreviewDelayed: () => Boolean(delayedPreview?.requested),
  releasePreview: () => delayedPreview?.release(),
})
;(window as any).browserHistoryReady = true
