import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { reconcileWorkspaceTabs, workspaceIdentity } from "./app-session-reconciliation"
import { createRestorableSessionPreservation, markPreservedWorkspaceRemoved, mergeRestorableSessionState } from "./app-session-snapshot-merge"
import { decodeClientSnapshot, normalizeRestorableSession, type RestorableWorkspaceTabState } from "./client-state-codec"
import { decodeClientSnapshotV2, encodeClientSnapshotV2 } from "./client-state-partitions"
import { BackendWorkspaceListReconciliationFence } from "./workspace-list-reconciliation-fence"

const tab = (folder: string, extra: Partial<RestorableWorkspaceTabState> = {}): RestorableWorkspaceTabState => ({
  kind: "workspace", folder, occurrence: 0, drafts: { s1: `draft for ${folder}` }, attachments: {}, scrollSnapshots: {},
  unseenIdleSince: {}, generationRecovery: {}, ...extra,
})

describe("client state with backend ids", () => {
  it("decodes a state saved without backend ids exactly as before", () => {
    const saved = { tabs: [tab("/repo", { projectName: "Repo" }), { kind: "sidecar", sidecarId: "car" }], activeTabIndex: 0 }
    const decoded = normalizeRestorableSession(structuredClone(saved))
    assert.deepEqual(JSON.parse(JSON.stringify(decoded)), saved)
    assert.equal(("backendId" in decoded!.tabs[0]!), false)
  })

  it("keeps another backend's id, folds an explicit local id into absence and drops a malformed one", () => {
    const decoded = normalizeRestorableSession({
      tabs: [tab("/repo", { backendId: "lab" }), tab("/repo", { backendId: "local" as never }), tab("/x", { backendId: "a:b" as never })],
      activeTabIndex: 0,
    })
    assert.deepEqual(decoded?.tabs.map((entry) => entry.kind === "workspace" ? [entry.folder, entry.backendId] : null),
      [["/repo", "lab"], ["/repo", undefined]])
    assert.equal(("backendId" in decoded!.tabs[1]!), false)
  })

  it("round-trips the backend id through the snapshot and partitioned formats", async () => {
    const snapshot = decodeClientSnapshot({
      version: 1, revision: 3, savedAt: 1, layout: {},
      session: { tabs: [tab("/repo"), tab("/repo", { backendId: "lab" })], activeTabIndex: 1 },
    })!
    assert.deepEqual(snapshot.session?.tabs.map((entry) => entry.kind === "workspace" ? entry.backendId : null), [undefined, "lab"])
    const encoded = await encodeClientSnapshotV2(snapshot)
    const decoded = await decodeClientSnapshotV2(encoded.root, 1, async (key) => encoded.partitions[key] ?? null)
    assert.deepEqual(decoded?.session, snapshot.session)
  })
})

describe("project identity is (backend, folder)", () => {
  it("matches a saved tab only to a live workspace of its own backend", () => {
    assert.equal(workspaceIdentity("C:\\Code\\", undefined), workspaceIdentity("c:/code", "local"))
    assert.notEqual(workspaceIdentity("/repo", "lab"), workspaceIdentity("/repo"))
    const matches = reconcileWorkspaceTabs(
      [{ kind: "workspace", folderPath: "/repo", occurrence: 0, backendId: "lab" }, { kind: "workspace", folderPath: "/repo" }],
      [{ id: "local-1", folderPath: "/repo", status: "ready" }, { id: "lab~w1", folderPath: "/repo", status: "ready", backendId: "lab" }],
    )
    assert.deepEqual(matches.map(({ existingWorkspaceId, descriptor }) => [existingWorkspaceId, descriptor.occurrence, descriptor.backendId]),
      [["lab~w1", 0, "lab"], ["local-1", 0, undefined]])
  })

  it("merges preserved state into the tab of the same backend and folder only", () => {
    const local = tab("/repo"), remote = tab("/repo", { backendId: "lab", drafts: { s1: "remote draft" } })
    const preservation = createRestorableSessionPreservation({ tabs: [local, remote], activeTabIndex: 0 })
    // The local tab was closed; the other backend's tab is still pending its backend.
    markPreservedWorkspaceRemoved(preservation, { runtimeTabId: "gone", folder: "/repo", occurrence: 0 })
    const merged = mergeRestorableSessionState({ tabs: [tab("/repo", { drafts: {} })], activeTabIndex: 0 }, preservation)
    assert.deepEqual(merged.tabs.map((entry) => entry.kind === "workspace" ? [entry.backendId, entry.drafts.s1] : null)
      .sort((a, b) => String(a?.[0]).localeCompare(String(b?.[0]))),
      [["lab", "remote draft"], [undefined, undefined]])
  })
})

describe("per-backend workspace list fence", () => {
  it("completing one backend's list keeps another backend's mutations and ignores its ids", () => {
    const fence = new BackendWorkspaceListReconciliationFence()
    const local = fence.begin("local"), lab = fence.begin("lab")
    fence.markMutation("w1")
    fence.markMutation("lab~w1")
    assert.equal(fence.allows(local, "w1"), false)
    assert.equal(fence.allows(local, "lab~w2"), false, "a local list never decides another backend's instance")
    fence.complete(local)
    assert.equal(fence.isCurrent(lab), true)
    assert.equal(fence.allows(lab, "lab~w1"), false)
    assert.equal(fence.allows(lab, "lab~w2"), true)
    assert.equal(fence.allows(fence.begin("local"), "w1"), true)
  })
})
