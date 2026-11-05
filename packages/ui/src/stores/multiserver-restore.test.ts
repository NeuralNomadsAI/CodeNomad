import assert from "node:assert/strict"
import { afterEach, beforeEach, it } from "node:test"
import toast from "solid-toast"
import { projectIdentity } from "../lib/project-identity"
import { normalizeRestorableSession, type RestorableWorkspaceTabState } from "./client-state-codec"
import { canonicalJson, sha256, decodeClientSnapshotV2, encodeClientSnapshotV2 } from "./client-state-partitions"
import { reconcileWorkspaceTabs } from "./app-session-reconciliation"
import {
  createRestorableSessionPreservation, createRestoredTabCommitGuard, markPreservedWorkspaceRemoved,
  mergeRestorableSessionState, recordRestoredTab, settleRestoredTab,
} from "./app-session-snapshot-merge"
import { addInstance, getExistingInstanceForFolder, removeInstance } from "./instances"
import { hydrateRestoredWorkspaceState, seedRestoredWorkspaceState } from "./app-session-workspace-hydration"
import { getSessionDraftPrompt } from "./session-state"
import { onInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { sdkManager } from "../lib/sdk-manager"
import { destroyOpenCodeData } from "./opencode-data"
import { attachInstanceTab, closeInstanceTab, getInstanceAppTabId } from "./app-tabs"
import { openInstanceTabIds } from "./app-tab-membership"
import { serverApi } from "../lib/api-client"

const originalToast = toast.custom
beforeEach(() => { toast.custom = () => "test-toast" })
afterEach(() => { toast.custom = originalToast })

const folder = "C:\\Work\\app\\"
function tab(serverId?: string, occurrence = 0): RestorableWorkspaceTabState {
  return {
    kind: "workspace", folder, ...(serverId ? { serverId } : {}), occurrence,
    activeSessionId: "same", activeParentSessionId: "same", drafts: { same: serverId ?? "local" },
    attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
    expandedSessionIds: ["same"],
  }
}

it("matches exact remote directories and legacy local paths independently across three targets and occurrences", () => {
  const tabs = [tab(), tab("A"), tab("B"), tab("A", 1)]
  const matches = reconcileWorkspaceTabs(tabs.map(t => ({ kind: t.kind, folderPath: t.folder, serverId: t.serverId, occurrence: t.occurrence })), [
    { id: "b", folderPath: folder, serverId: "B" },
    { id: "a1", folderPath: folder, serverId: "A" },
    { id: "local", folderPath: "c:/work/app", serverId: "local-shared" },
    { id: "a2", folderPath: folder, serverId: "A" },
  ])
  assert.deepEqual(matches.map(m => m.existingWorkspaceId), ["local", "a1", "b", "a2"])
  assert.notEqual(projectIdentity(folder, "A"), projectIdentity("c:/work/app", "A"))
  assert.notEqual(projectIdentity("/work", "A"), projectIdentity("/work/", "A"))
  assert.equal(projectIdentity(folder), projectIdentity("c:/work/app", "local-shared"))
})

it("preserves unbound/imported orphans, selection and independent window drafts without cross-publication or resurrection", () => {
  const snapshot = { tabs: [tab(), tab("A"), tab("deleted")], activeTabIndex: 2 }
  for (const window of ["one", "two"]) {
    const saved = createRestorableSessionPreservation(snapshot)
    recordRestoredTab(saved, 1, window)
    const guard = createRestoredTabCommitGuard(saved, 1)
    const current = { tabs: [{ ...tab("B"), drafts: { same: window } }], activeTabIndex: 0 }
    const merged = mergeRestorableSessionState(current, saved, { currentTabIds: [window] })
    assert.equal(merged.tabs.length, 4)
    assert.equal((merged.tabs.find(t => t.kind === "workspace" && t.serverId === "A") as RestorableWorkspaceTabState).drafts.same, "A")
    markPreservedWorkspaceRemoved(saved, { runtimeTabId: window, folder, serverId: "B", occurrence: 0 })
    assert.equal(guard(), true)
    markPreservedWorkspaceRemoved(saved, { runtimeTabId: window, folder, serverId: "A", occurrence: 0 })
    assert.equal(guard(), false)
    assert.equal(settleRestoredTab(saved, 1, window, window, new Set()), false)
    recordRestoredTab(saved, 1, window)
    assert.equal(saved.results[1]?.status, "removed")
    const closed = mergeRestorableSessionState({ tabs: [], activeTabIndex: -1 }, saved)
    assert.deepEqual(closed.tabs.map(t => t.kind === "workspace" && t.serverId), [undefined, "deleted"])
    assert.equal(closed.activeTabIndex, 1)
  }
})

it("round-trips server-qualified V2 partitions and discards transient authority and development credentials on import", async () => {
  const session = normalizeRestorableSession({
    tabs: [tab(), { ...tab("unknown"), sourceGeneration: 99, token: "retired", hasCredentials: true, credentialRef: "old-ref", credentialMode: "keychain" }],
    activeTabIndex: 1,
  })!
  assert.deepEqual(JSON.parse(JSON.stringify(session.tabs)), [tab(), tab("unknown")])
  const encoded = await encodeClientSnapshotV2({ version: 1, revision: 2, savedAt: 1, layout: {}, session })
  const decoded = await decodeClientSnapshotV2(encoded.root, 1, async key => encoded.partitions[key] ?? null)
  assert.deepEqual(decoded?.session, session)
  assert.equal(JSON.stringify(encoded).includes("old-ref"), false)
  assert.equal(JSON.stringify(encoded).includes("hasCredentials"), false)
})

it("retains target identity, selected drafts and attachments when an optional catalog chunk is corrupt", async () => {
  const remote = tab("deleted")
  remote.attachments.same = [{ id: "attachment", type: "text", display: "@text", url: "", filename: "text.txt", mediaType: "text/plain", source: { type: "text", value: "remote bytes" } }]
  remote.sessionCatalog = [{ id: "same", parentId: null, title: "remote title", projectID: "project", location: { directory: folder }, time: { created: 1, updated: 2 }, agent: "build", model: { providerId: "p", modelId: "m" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }]
  const session = normalizeRestorableSession({ tabs: [tab(), tab("A"), remote], activeTabIndex: 2 })!
  const encoded = await encodeClientSnapshotV2({ version: 1, revision: 3, savedAt: 1, layout: {}, session })
  const decoded = await decodeClientSnapshotV2(encoded.root, 1, async key => encoded.partitions[key] ?? null)
  assert.deepEqual(decoded?.session, session)
  const manifest = JSON.parse(encoded.partitions[encoded.root.sessionPartition]!)
  const workspace = JSON.parse(encoded.partitions[manifest.session.tabs[2].workspacePartition]!)
  const damaged = workspace.catalogPartitions[0]
  const degraded = await decodeClientSnapshotV2(encoded.root, 1, async key => key === damaged ? null : encoded.partitions[key] ?? null)
  const restored = degraded?.session?.tabs[2] as RestorableWorkspaceTabState
  assert.equal(restored.serverId, "deleted")
  assert.equal(restored.drafts.same, "deleted")
  assert.deepEqual(restored.attachments, remote.attachments)
  assert.equal(restored.sessionCatalog, undefined)
  assert.equal(degraded?.session?.activeTabIndex, 2)

  // A development shell is read without a secret lookup, then written cleanly.
  manifest.session.tabs[2].credentialMode = "keychain"
  manifest.session.tabs[2].credentialRef = "retired-reference"
  const text = canonicalJson(manifest), key = await sha256(text)
  const partitions = { ...encoded.partitions, [key]: text }
  delete partitions[encoded.root.sessionPartition]
  const root = { ...encoded.root, sessionPartition: key, partitionKeys: Object.keys(partitions).sort() }
  const migrated = await decodeClientSnapshotV2(root, 1, async k => partitions[k] ?? null)
  assert.deepEqual(migrated?.session, session)
  assert.equal(JSON.stringify(migrated).includes("retired-reference"), false)
})

it("real store occurrence lifecycle and seeded drafts remain isolated for two windows on each target", () => {
  const opened: Array<{ instanceId: string; serverId?: string; occurrence: number }> = []
  const unsubscribe = onInstanceLifecycleAuthority(event => { if (event.type === "opened") opened.push(event) })
  const ids: string[] = []
  try {
    for (const serverId of ["local-shared", "A", "B"]) for (const window of [1, 2]) {
      const id = `${serverId}-${window}`
      ids.push(id)
      addInstance({ id, folder, binding: { serverId, directory: folder }, client: null, status: "ready", proxyPath: "", port: 0, pid: 0 })
      seedRestoredWorkspaceState(id, { ...tab(serverId), drafts: { __no_session_draft__: id } })
      assert.equal(getSessionDraftPrompt(id, "__no_session_draft__"), id)
    }
    assert.deepEqual(opened.map(event => event.occurrence), [0, 1, 0, 1, 0, 1])
    assert.equal(getExistingInstanceForFolder(folder)?.id.startsWith("local-shared-"), true)
    assert.equal(getExistingInstanceForFolder(folder, "A")?.id.startsWith("A-"), true)
    removeInstance("A-1")
    assert.equal(getSessionDraftPrompt("A-2", "__no_session_draft__"), "A-2")
    assert.equal(getSessionDraftPrompt("B-1", "__no_session_draft__"), "B-1")
  } finally { unsubscribe(); ids.forEach(id => removeInstance(id, { authoritative: false })) }
})

it("refuses hydration across target identity even if a stale runtime binding says current", async () => {
  const id = "multiserver-hydration"
  let calls = 0
  const client = { session: { get: () => { calls++; throw new Error("Unexpected HTTP") } } } as any
  addInstance({ id, folder, binding: { serverId: "B", directory: folder }, client, status: "ready", proxyPath: "", port: 0, pid: 0 })
  try {
    assert.equal(await hydrateRestoredWorkspaceState(id, tab("A"), new AbortController().signal, () => true), null)
    assert.equal(getSessionDraftPrompt(id, "same"), "")
    assert.equal(calls, 0)
  } finally { removeInstance(id, { authoritative: false }) }
})

it("fences late restoration when the source generation changes on the same live client", async () => {
  const id = "multiserver-late-generation"
  let resolve!: (value: unknown) => void, started!: () => void
  const response = new Promise(done => { resolve = done })
  const dispatched = new Promise<void>(done => { started = done })
  const client = { session: { get: () => { started(); return response } } } as any
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder, binding: { serverId: "A", directory: folder }, client, status: "ready", proxyPath: "", port: 0, pid: 0 })
  try {
    const hydration = hydrateRestoredWorkspaceState(id, tab("A"), new AbortController().signal, () => true)
    await dispatched
    destroyOpenCodeData(id)
    resolve({ id: "same", title: "late", projectID: "project", location: { directory: folder }, time: { created: 1, updated: 1 }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    assert.equal(await hydration, null)
    assert.equal(getSessionDraftPrompt(id, "same"), "")
  } finally { removeInstance(id, { authoritative: false }); sdkManager.destroyClientsForInstance(id) }
})

it("accepted local tab close retires only its qualified occurrence even when DELETE fails", async () => {
  const targets = [tab(), tab("A"), tab("A", 1), tab("B"), { ...tab("A"), folder: "c:/work/app" }]
  const saved = createRestorableSessionPreservation({ tabs: targets, activeTabIndex: 2 })
  const ids = targets.map((_, index) => `qualified-close-${index}`)
  const events: Array<{ serverId?: string; occurrence: number }> = []
  const unsubscribe = onInstanceLifecycleAuthority(event => {
    if (event.type !== "removed") return
    events.push(event)
    markPreservedWorkspaceRemoved(saved, { ...event, runtimeTabId: getInstanceAppTabId(event.instanceId) })
  })
  const original = serverApi.deleteWorkspace
  let deletes = 0
  serverApi.deleteWorkspace = async () => { deletes++; throw new Error("503 fixture refusal") }
  try {
    targets.forEach((target, index) => {
      const id = ids[index]!
      addInstance({ id, folder: target.folder, binding: { serverId: target.serverId ?? "local-shared", directory: target.folder }, client: null, status: "ready", proxyPath: "", port: 0, pid: 0 })
      attachInstanceTab(id, { source: "restore" })
      recordRestoredTab(saved, index, getInstanceAppTabId(id))
    })
    const current = createRestoredTabCommitGuard(saved, 2)
    closeInstanceTab(ids[2]!)
    for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(deletes, 1)
    assert.deepEqual(events, [{ type: "removed", instanceId: ids[2], folder, serverId: "A", occurrence: 1 }])
    assert.equal(current(), false)
    assert.equal(openInstanceTabIds().has(ids[2]!), false)
    for (const id of ids.filter((_, index) => index !== 2)) assert.equal(openInstanceTabIds().has(id), true)
    const captured = mergeRestorableSessionState({ tabs: [], activeTabIndex: -1 }, saved)
    assert.deepEqual(captured.tabs, targets.filter((_, index) => index !== 2))
  } finally { unsubscribe(); ids.forEach(id => removeInstance(id, { authoritative: false })); serverApi.deleteWorkspace = original }
})
