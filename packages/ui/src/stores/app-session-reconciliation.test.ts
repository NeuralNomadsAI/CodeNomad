import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { getUnavailableRestoredSessionIds, reconcileWorkspaceTabs, resolveRestoredActiveTabId, resolveRestoredSessionSelection, shouldRestoreSessionState } from "./app-session-reconciliation.ts"
describe("app session reconciliation", () => {
  const workspaceCases = [
    ["matches duplicate workspace folders by normalized path occurrence", [
      { kind: "workspace" as const, folderPath: String.raw`C:\Code\Nomad`, occurrence: 1 }, { kind: "workspace" as const, folderPath: "c:/code/nomad/", occurrence: 0 },
    ], [{ id: "first", folderPath: "C:/CODE/NOMAD" }, { id: "second", folderPath: "c:\\code\\nomad\\" }], ["second", "first"]],
    ["derives occurrences for snapshots written before occurrence was explicit", [
      { kind: "workspace" as const, folderPath: "/code/nomad" }, { kind: "workspace" as const, folderPath: "/code/nomad/" },
    ], [{ id: "first", folderPath: "/code/nomad" }, { id: "second", folderPath: "/code/nomad" }], ["first", "second"]],
    ["does not match one live workspace to duplicate descriptors", [
      { kind: "workspace" as const, folderPath: "/code/nomad", occurrence: 0 }, { kind: "workspace" as const, folderPath: "/code/nomad", occurrence: 0 },
    ], [{ id: "only", folderPath: "/code/nomad" }], ["only", null]],
  ] as const
  for (const [label, saved, live, expected] of workspaceCases) it(label, () => assert.deepEqual(
    reconcileWorkspaceTabs([...saved], [...live]).map(({ existingWorkspaceId }) => existingWorkspaceId), expected,
  ))
  it("keeps saved order while a restored workspace is still starting", () => {
    const saved = [
      { kind: "workspace", folderPath: "D:/DreamX-World" },
      { kind: "workspace", folderPath: "D:/CodeNomad" },
      { kind: "workspace", folderPath: "D:/stale" },
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
  const selectionCases = [
    ["falls back to a valid parent when the active session is stale", [{ id: "parent", parentId: null }, { id: "child", parentId: "parent" }], "parent", "deleted-child", { parentSessionId: "parent", activeSessionId: "parent" }],
    ["restores a grandchild under its root session", [{ id: "root", parentId: null }, { id: "child", parentId: "root" }, { id: "grandchild", parentId: "child" }], "root", "grandchild", { parentSessionId: "root", activeSessionId: "grandchild" }],
    ["keeps the special info selection without requiring a session", [], null, "info", { parentSessionId: null, activeSessionId: "info" }],
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
