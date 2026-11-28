import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { getUnavailableRestoredSessionIds, getUnavailableWorkspaceIds, reconcileWorkspaceTabs, resolveRestoredActiveTabId, resolveRestoredSessionSelection, shouldRestoreSessionState } from "./app-session-reconciliation.ts"
describe("app session reconciliation", () => {
  const workspaceCases = [
    ["matches saved IDs of duplicate workspace folders by normalized path", [
      { kind: "workspace" as const, folderPath: String.raw`C:\Code\Nomad`, occurrence: 1, workspaceId: "second" }, { kind: "workspace" as const, folderPath: "c:/code/nomad/", occurrence: 0, workspaceId: "first" },
    ], [{ id: "first", folderPath: "C:/CODE/NOMAD" }, { id: "second", folderPath: "c:\\code\\nomad\\" }], ["second", "first"]],
    ["does not adopt same-folder records without saved IDs", [
      { kind: "workspace" as const, folderPath: "/code/nomad" }, { kind: "workspace" as const, folderPath: "/code/nomad/" },
    ], [{ id: "first", folderPath: "/code/nomad" }, { id: "second", folderPath: "/code/nomad" }], [null, null]],
    ["does not match one live workspace to duplicate descriptors", [
      { kind: "workspace" as const, folderPath: "/code/nomad", workspaceId: "only" }, { kind: "workspace" as const, folderPath: "/code/nomad", workspaceId: "only" },
    ], [{ id: "only", folderPath: "/code/nomad" }], ["only", null]],
    ["prefers a saved record that still exists when a closed sibling shifted occurrences", [
      { kind: "workspace" as const, folderPath: "/code/nomad", occurrence: 1, workspaceId: "b" },
    ], [{ id: "b", folderPath: "/code/nomad" }], ["b"]],
    ["recreates a missing record instead of adopting a different window's occurrence", [
      { kind: "workspace" as const, folderPath: "/code/nomad", occurrence: 0, workspaceId: "gone" },
      { kind: "workspace" as const, folderPath: "/code/nomad", occurrence: 1, workspaceId: "a" },
    ], [{ id: "b", folderPath: "/code/nomad" }, { id: "a", folderPath: "/code/nomad" }], [null, "a"]],
    ["matches a saved id only within the same folder", [
      { kind: "workspace" as const, folderPath: "/code/other", occurrence: 0, workspaceId: "a" },
    ], [{ id: "a", folderPath: "/code/nomad" }, { id: "c", folderPath: "/code/other" }], [null]],
    ["prefers surviving remote records within their backend after sibling closure", [
      { kind: "workspace" as const, folderPath: "/same", occurrence: 1, workspaceId: "a~survivor", backendId: "a", serverId: "installation-a" },
      { kind: "workspace" as const, folderPath: "/same", occurrence: 0 },
      { kind: "workspace" as const, folderPath: "/same", occurrence: 0, backendId: "b", workspaceId: "a~survivor" },
    ], [
      { id: "survivor", folderPath: "/same" },
      { id: "a~survivor", folderPath: "/same", backendId: "a", serverId: "installation-a" },
    ], ["a~survivor", null, null]],
  ] as const
  for (const [label, saved, live, expected] of workspaceCases) it(label, () => assert.deepEqual(
    reconcileWorkspaceTabs([...saved], [...live]).map(({ existingWorkspaceId }) => existingWorkspaceId), expected,
  ))
  it("rejects both saved-id and occurrence matches from another installation or an unverified snapshot", () => {
    const live = { id: "a~record", folderPath: "/same", backendId: "a", serverId: "installation-new" }
    for (const workspaceId of [live.id, "a~closed"]) {
      for (const serverId of ["installation-old", undefined, live.serverId]) {
        const tabs = [{ kind: "workspace", folderPath: live.folderPath, backendId: live.backendId, workspaceId, serverId }]
        assert.equal(reconcileWorkspaceTabs(tabs, [live])[0]?.existingWorkspaceId, serverId === live.serverId && workspaceId === live.id ? live.id : null)
      }
    }
  })
  it("keeps saved order while a restored workspace is still starting", () => {
    const saved = [
      { kind: "workspace", folderPath: "D:/DreamX-World", workspaceId: "dreamx" },
      { kind: "workspace", folderPath: "D:/CodeNomad", workspaceId: "codenomad" },
      { kind: "workspace", folderPath: "D:/stale", workspaceId: "stale" },
    ]
    const live = [
      { id: "codenomad", folderPath: "D:/CodeNomad", status: "ready" },
      { id: "dreamx", folderPath: "D:/DreamX-World", status: "starting" },
      { id: "stale", folderPath: "D:/stale", status: "stopped" },
    ] as const

    assert.deepEqual(
      reconcileWorkspaceTabs(saved, live).map(({ existingWorkspaceId }) => existingWorkspaceId),
      ["dreamx", "codenomad", null],
    )
  })
  it("reconciles only workspaces missing from a refresh and not owned by restore cleanup", () => {
    assert.deepEqual(
      getUnavailableWorkspaceIds(["present", "stopped", "cancelling"], new Set(["present"]), (id) => id === "cancelling"),
      ["stopped"],
    )
  })
  const selectionCases = [
    ["falls back to a valid parent when the active session is stale", [{ id: "parent", parentId: null }, { id: "child", parentId: "parent" }], "parent", "deleted-child", { parentSessionId: "parent", activeSessionId: "parent" }],
    ["restores a grandchild under its root session", [{ id: "root", parentId: null }, { id: "child", parentId: "root" }, { id: "grandchild", parentId: "child" }], "root", "grandchild", { parentSessionId: "root", activeSessionId: "grandchild" }],
    ["drops a non-session selection once parent hydration confirms absence", [], null, "info", null],
    ["restores the parent from a saved info selection", [{ id: "parent" }], "parent", "info", { parentSessionId: "parent", activeSessionId: "parent" }],
  ] as const
  for (const [label, sessions, parent, active, expected] of selectionCases) it(label, () => assert.deepEqual(
    resolveRestoredSessionSelection([...sessions], parent, active), expected,
  ))
  it("rejects ancestry with a cycle or missing parent", () => {
    assert.equal(resolveRestoredSessionSelection([{ id: "first", parentId: "second" }, { id: "second", parentId: "first" }], null, "first"), null)
    assert.equal(resolveRestoredSessionSelection([{ id: "orphan", parentId: "missing" }], null, "orphan"), null)
  })
  it("treats missing saved session references as unsafe", () => {
    const sessions = [{ id: "loaded", parentId: null }]
    const unavailable = (state: Parameters<typeof getUnavailableRestoredSessionIds>[1], allowed: string[] = []) => [...getUnavailableRestoredSessionIds(sessions, state, allowed)]
    assert.deepEqual(unavailable({ activeParentSessionId: "loaded", activeSessionId: "info", draftSessionIds: ["loaded", "__no_session_draft__"], attachmentSessionIds: ["loaded"], scrollSessionIds: ["loaded"] }, ["__no_session_draft__"]), [])
    assert.notEqual(unavailable({ activeParentSessionId: "missing-parent", activeSessionId: "missing-active", draftSessionIds: ["missing-draft"], attachmentSessionIds: ["missing-attachment"], scrollSessionIds: ["missing-scroll"] }).length, 0)
    assert.deepEqual(unavailable({ activeSessionId: "missing-active", draftSessionIds: ["missing-draft"], attachmentSessionIds: ["missing-attachment"], scrollSessionIds: ["loaded"] }), ["missing-active", "missing-draft", "missing-attachment"])
    assert.deepEqual(unavailable({ draftSessionIds: [], scrollSessionIds: [], expandedSessionIds: ["loaded", "later"] }), ["later"])
  })

  it("falls back to the first restored tab when the active SideCar failed", () => {
    assert.equal(resolveRestoredActiveTabId(["instance:workspace", null, "sidecar:other"], 1), "instance:workspace")
  })
  it("does not restore for secondary or disabled clients", () => {
    const snapshot = { tabs: [] }
    for (const [primary, enabled, state, expected] of [[false, true, snapshot, false], [true, false, snapshot, false], [true, true, null, false], [true, true, snapshot, true]] as const) {
      assert.equal(shouldRestoreSessionState(primary, enabled, state), expected)
    }
  })
})
