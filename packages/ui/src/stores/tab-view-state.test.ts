import assert from "node:assert/strict"
import { it } from "node:test"
import { normalizeRestorableSession, type RestorableWorkspaceTabState } from "./client-state-codec.ts"
import { canonicalJson, decodeClientSnapshotV2, encodeClientSnapshotV2, sha256 } from "./client-state-partitions.ts"
import { normalizeTabViewState, MAX_TAB_PREVIEW_STORAGE, type RestorableTabViewState } from "./tab-view-state-codec.ts"
import { migrateLegacyTabPreviews } from "./tab-view-state-migration.ts"
import { captureTabViewState, clearTabViewState, getTabViewState, seedTabViewState, updateTabViewState } from "./tab-view-state.ts"
import { publishInstanceLifecycleAuthority } from "./instance-lifecycle-authority.ts"
import {
  createRestorableSessionPreservation, markPreservedWorkspaceRemoved, mergeRestorableSessionState, recordRestoredTab,
} from "./app-session-snapshot-merge.ts"

const preview = (path = "a") => ({ mode: "preview" as const, targetUrl: `https://example.com/${path}`,
  history: { urls: [`https://example.com/${path}`], index: 0 } })
const view = (path: string): RestorableTabViewState => ({
  version: 1, previews: { session: preview(path) }, rightPanelTab: path, filesMode: "changes",
})
const workspace = (occurrence: number, viewState?: RestorableTabViewState): RestorableWorkspaceTabState => ({
  kind: "workspace", folder: "/same", occurrence, activeSessionId: "session",
  drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
  ...(viewState ? { viewState } : {}),
})
const session = (tabs: RestorableWorkspaceTabState[]) => ({ tabs, activeTabIndex: 0 })

it("restores occurrence views on recreated UUIDs; repeated hydration and sibling closure preserve local choices", () => {
  const a = "new-backend-a", b = "new-backend-b"
  assert.equal(captureTabViewState(a), undefined)
  seedTabViewState(a, view("a"))
  seedTabViewState(b, { ...view("b"), missions: { reader: { missionId: "mission", kind: "recurrence",
    instanceId: "old-backend", projectID: "project" } } })
  assert.equal(getTabViewState(b).missions?.reader?.instanceId, b)
  updateTabViewState(a, { previews: { session: { ...preview("a"), mode: "chat" } } })
  seedTabViewState(a, view("stale"))
  assert.equal(getTabViewState(a).previews?.session.mode, "chat")
  assert.equal(getTabViewState(b).previews?.session.targetUrl, preview("b").targetUrl)
  publishInstanceLifecycleAuthority({ type: "unavailable", instanceId: b, folder: "/same", occurrence: 1 })
  assert.equal(getTabViewState(b).rightPanelTab, "b", "Backend unavailability preserves reload/recovery state")
  publishInstanceLifecycleAuthority({ type: "removed", instanceId: a, folder: "/same", occurrence: 0 })
  assert.equal(captureTabViewState(a), undefined)
  assert.equal(getTabViewState(b).rightPanelTab, "b")
  clearTabViewState(b)
})

it("keeps descriptor views through reorder, partial restore and closing the first duplicate", () => {
  const saved = session([workspace(0, view("a")), workspace(1, view("b"))])
  const preservation = createRestorableSessionPreservation(saved)
  recordRestoredTab(preservation, 0, "instance:a", new Set(["unloaded"]))
  recordRestoredTab(preservation, 1, "instance:b")
  const reordered = mergeRestorableSessionState(session([workspace(1), workspace(0)]), preservation, {
    currentTabIds: ["instance:b", "instance:a"],
  })
  assert.deepEqual(reordered.tabs.map(tab => tab.kind === "workspace" && tab.viewState?.rightPanelTab), ["b", "a"])
  markPreservedWorkspaceRemoved(preservation, { runtimeTabId: "instance:a", folder: "/same", occurrence: 0 })
  const afterClose = mergeRestorableSessionState(session([workspace(0, { version: 1 })]), preservation, {
    currentTabIds: ["instance:b"],
  })
  assert.equal(afterClose.tabs.length, 1)
  assert.deepEqual((afterClose.tabs[0] as RestorableWorkspaceTabState).viewState, { version: 1 }, "An explicit empty view wins")
})

it("migrates folder/session entries to every matching restored descriptor and project URLs to the first selected descriptor", () => {
  const raw = JSON.stringify({ [JSON.stringify(["/same", "session"])]: preview(), "/other": preview("legacy"),
    [JSON.stringify(["/unopened", "session"])]: preview("keep") })
  const state = session([workspace(1), workspace(0), { ...workspace(0), folder: "/other" }, { ...workspace(1), folder: "/other" }])
  const migration = migrateLegacyTabPreviews(state, raw)!
  assert.deepEqual(migration.state.tabs.slice(0, 2).map(tab => tab.kind === "workspace" && tab.viewState?.previews?.session), [preview(), preview()])
  assert.equal((migration.state.tabs[2] as RestorableWorkspaceTabState).viewState?.previews?.session.targetUrl, preview("legacy").targetUrl)
  assert.equal((migration.state.tabs[3] as RestorableWorkspaceTabState).viewState, undefined)
  assert.deepEqual(Object.keys(JSON.parse(migration.remaining)), [JSON.stringify(["/unopened", "session"])])
  const again = migrateLegacyTabPreviews(migration.state, raw)!
  assert.deepEqual(again.state, migration.state, "Interrupted cleanup retries deterministically")
  assert.equal(migrateLegacyTabPreviews(state, "{corrupt"), null)
  const mixed = migrateLegacyTabPreviews(session([workspace(0)]), JSON.stringify({
    "/same": preview("project"), [JSON.stringify(["/same", "session"])]: preview("specific"),
  }))!
  assert.equal((mixed.state.tabs[0] as RestorableWorkspaceTabState).viewState?.previews?.session.targetUrl, preview("specific").targetUrl)
})

it("validates optional fields and trims history before previews within the shared window budget", () => {
  const corrupt = JSON.parse('{"version":1,"previews":{"__proto__":{"mode":"preview","targetUrl":"https://safe.test/"},"bad":{"mode":"preview","targetUrl":"https://user:password@example.com/"}},"filesMode":"bad","rightPanelTab":42,"missions":{"reader":{"missionId":"x","kind":"recurrence"}}}')
  assert.deepEqual(normalizeTabViewState(corrupt), { version: 1, missions: {} })
  assert.equal(normalizeTabViewState({ version: 2 }), undefined)
  assert.equal(normalizeTabViewState({ version: 1, previews: { session: preview("é".repeat(1000)) } })?.previews, undefined,
    "Normalized URLs obey the same length bound as their input")
  const urls = Array.from({ length: 32 }, (_, i) => `https://example.com/${i}/${"x".repeat(100)}`)
  const bulky: RestorableTabViewState = { version: 1, previews: Object.fromEntries(Array.from({ length: 32 }, (_, i) =>
    [`session-${i}`, { targetUrl: urls[16], mode: "preview", history: { urls: [...urls], index: 16 } }])) }
  const normalized = normalizeRestorableSession(session([workspace(0, bulky), workspace(1, bulky)]))!
  const size = normalized.tabs.reduce((total, tab) => total + (tab.kind === "workspace" && tab.viewState?.previews
    ? JSON.stringify(tab.viewState.previews).length : 0), 0)
  assert.ok(size <= MAX_TAB_PREVIEW_STORAGE)
  const previews = (normalized.tabs[0] as RestorableWorkspaceTabState).viewState?.previews ?? {}
  assert.ok(Object.keys(previews).length > 0)
  for (const p of Object.values(previews)) assert.equal(p.history?.urls[p.history.index], p.targetUrl)
})

it("round trips distinct descriptor envelopes through strict partitions and degrades corrupt optional view data", async () => {
  const source = { version: 1 as const, revision: 1, savedAt: 2, layout: {}, session: session([workspace(1, view("b")), workspace(0, view("a"))]) }
  const encoded = await encodeClientSnapshotV2(source)
  const loaded = await decodeClientSnapshotV2(encoded.root, 1, async key => encoded.partitions[key] ?? null)
  assert.equal(canonicalJson(loaded), canonicalJson(source))
  const manifest = JSON.parse(encoded.partitions[encoded.root.sessionPartition])
  const shell = manifest.session.tabs[0]
  const oldWorkspace = shell.workspacePartition
  const changed = JSON.parse(encoded.partitions[oldWorkspace])
  changed.viewState = { version: 99 }
  const text = canonicalJson(changed), changedKey = await sha256(text)
  encoded.partitions[changedKey] = text
  delete encoded.partitions[oldWorkspace]
  shell.workspacePartition = changedKey
  const rootText = canonicalJson(manifest), rootKey = await sha256(rootText)
  delete encoded.partitions[encoded.root.sessionPartition]
  encoded.partitions[rootKey] = rootText
  encoded.root.sessionPartition = rootKey
  encoded.root.partitionKeys = Object.keys(encoded.partitions).sort()
  const degraded = await decodeClientSnapshotV2(encoded.root, 1, async key => encoded.partitions[key] ?? null)
  assert.equal((degraded?.session?.tabs[0] as RestorableWorkspaceTabState)?.viewState, undefined)
  assert.deepEqual((degraded?.session?.tabs[1] as RestorableWorkspaceTabState)?.viewState, view("a"))
})
