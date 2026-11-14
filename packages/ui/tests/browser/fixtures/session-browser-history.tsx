import { nativeFixture } from "./browser-frame-native-bridge"
import { serverApi } from "../../../src/lib/api-client"
import { getSessionPreview, openSessionPreview, sessionPreviews } from "../../../src/stores/session-previews"
import { initializeClientState, writeClientLayoutValue } from "../../../src/stores/client-state"
import { getTabViewState, seedTabViewState } from "../../../src/stores/tab-view-state"
import { migrateLegacyTabPreviews } from "../../../src/stores/tab-view-state-migration"
import { publishInstanceLifecycleAuthority } from "../../../src/stores/instance-lifecycle-authority"
import { addInstance, instances, removeInstance } from "../../../src/stores/instances"
import { missionStore } from "../../../src/stores/missions"
import { missionProjectView, updateMissionProjectView } from "../../../src/stores/mission-view-state"
import { showSessionChatFor } from "../../../src/stores/session-previews"
import { getFilePreview, openFilePreview } from "../../../src/stores/files-preview"
import { markSessionListsRestored } from "./session-list-restored"
import { restoreFixtureTabView } from "./tab-view-restoration"
import { RIGHT_PANEL_TAB_STORAGE_KEY } from "../../../src/components/instance/shell/storage"
import { sseManager } from "../../../src/lib/sse-manager"
import { sessions, activeSessionId } from "../../../src/stores/session-state"

// The production shell, session switching, preview store and native guests run
// unchanged. Only server responses and the native registration IPC are fixtures.
let nextToken = 0
const deletedPreviews: string[] = []
let delayedPreview: { url: string; requested: boolean; promise: Promise<void>; release: () => void; fail?: boolean } | undefined
serverApi.createPreview = async ({ sessionId, url }) => {
  const delay = delayedPreview
  if (delay?.url === url && !delay.requested) {
    delay.requested = true
    await delay.promise
    delayedPreview = undefined
    if (delay.fail) throw new Error("Delayed preview failure")
  }
  return { sessionId, targetUrl: url, token: `preview-${++nextToken}`, proxyUrl: url, createdAt: new Date().toISOString() }
}
serverApi.deletePreview = async token => { deletedPreviews.push(token) }
await initializeClientState()
if (new URLSearchParams(location.search).has("missions")) writeClientLayoutValue(RIGHT_PANEL_TAB_STORAGE_KEY, "missions")
const ids = ["header-windows", "header-duplicate"]
// This standalone shell fixture has no App capture hook; serialize its actual
// occurrence envelopes at the same persistence boundary as workspace descriptors.
for (const id of ids) restoreFixtureTabView(id)
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
await import("./header-windows")
for (const id of ids) markSessionListsRestored(id)
serverApi.previewWorkspaceFile = async (id, path) => ({
  workspaceId: id, relativePath: path, encoding: "base64", contents: path.endsWith(".png")
    ? "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
    : btoa(`# ${path}\n\nIndependent file content.`
    + (path === "Long.md" ? "\n\n" + Array.from({ length: 250 }, (_, index) => `Paragraph ${index}\n\n`).join("") : "")),
} as any)
serverApi.fetchWorktreeGitDiff = async () => ({ path: "diff.ts", before: "const value = 1\n", after: "const value = 2\n" } as any)
const shell = (window as any).fixture
shell.addSession("second")
let eventTime = 1000
Object.assign(shell, {
  native: nativeFixture,
  openPreview: (sessionId: string, url: string, instanceId = ids[0]) => openSessionPreview(sessionId, url, instanceId),
  preview: (sessionId: string, instanceId = ids[0]) => getSessionPreview(sessionId, instanceId),
  savedPreview: (sessionId: string, instanceId = ids[0]) => getTabViewState(instanceId).previews?.[sessionId],
  readMission: async (instanceId: string, kind: "overview" | "report", itemId?: string) => {
    await missionStore.refresh(instanceId)
    showSessionChatFor("session", instanceId)
    updateMissionProjectView(instanceId, { selected: "mission-a", reader: { missionId: "mission-a", kind, itemId } })
  },
  readFile: (instanceId: string, path: string) => {
    showSessionChatFor("session", instanceId)
    openFilePreview(instanceId, { sessionId: "session", kind: "workspace", slug: "root", directory: "/repo", path })
  },
  readDiff: (instanceId: string) => openFilePreview(instanceId, { sessionId: "session", kind: "diff",
    slug: "root", directory: "/repo", path: "diff.ts", scope: "unstaged" }),
  presentation: (instanceId: string) => ({ mission: missionProjectView(instanceId), file: getFilePreview(instanceId) }),
  selection: (instanceId: string) => activeSessionId().get(instanceId),
  closeOccurrence: (instanceId: string) => {
    publishInstanceLifecycleAuthority({ type: "removed", instanceId, folder: "/repo", occurrence: ids.indexOf(instanceId) })
    removeInstance(instanceId)
  },
  previewCount: () => sessionPreviews().size,
  registerHiddenOccurrence: (id: string) => addInstance({ ...instances().get(ids[0])!, id, folder: id, proxyPath: `/workspaces/${id}/instance` }),
  execution: (type: "started" | "succeeded") => {
    const event = { id: `evt_${++eventTime}`, type: `session.execution.${type}`, created: eventTime,
      location: { directory: "/repo" }, data: { sessionID: "session" } }
    for (const id of ids) (sseManager as any).handleEvent(id, event)
  },
  status: (id: string) => sessions().get(id)?.get("session")?.status,
  deletedPreviews,
  delayPreview: (url: string, fail = false) => {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    delayedPreview = { url, requested: false, promise, release, fail }
  },
  isPreviewDelayed: () => Boolean(delayedPreview?.requested),
  releasePreview: () => delayedPreview?.release(),
})
;(window as any).browserHistoryReady = true
