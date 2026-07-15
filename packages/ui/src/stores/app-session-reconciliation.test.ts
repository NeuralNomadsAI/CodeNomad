import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  areRestoredSessionReferencesAvailable,
  getUnavailableRestoredSessionIds,
  reconcileWorkspaceTabs,
  resolveRestoredActiveTabId,
  resolveRestoredSessionSelection,
  shouldEnableSessionCapture,
  shouldRestoreSessionState,
} from "./app-session-reconciliation.ts"

describe("app session reconciliation", () => {
  it("matches duplicate workspace folders by normalized path occurrence", () => {
    const matches = reconcileWorkspaceTabs(
      [
        { kind: "workspace", folderPath: String.raw`C:\Code\Nomad`, occurrence: 1 },
        { kind: "workspace", folderPath: "c:/code/nomad/", occurrence: 0 },
      ],
      [
        { id: "first", folderPath: "C:/CODE/NOMAD" },
        { id: "second", folderPath: "c:\\code\\nomad\\" },
      ],
    )

    assert.deepEqual(matches.map((match) => match.existingWorkspaceId), ["second", "first"])
  })

  it("derives occurrences for snapshots written before occurrence was explicit", () => {
    const matches = reconcileWorkspaceTabs(
      [
        { kind: "workspace", folderPath: "/code/nomad" },
        { kind: "workspace", folderPath: "/code/nomad/" },
      ],
      [
        { id: "first", folderPath: "/code/nomad" },
        { id: "second", folderPath: "/code/nomad" },
      ],
    )

    assert.deepEqual(matches.map((match) => match.existingWorkspaceId), ["first", "second"])
  })

  it("does not match one live workspace to duplicate descriptors", () => {
    const matches = reconcileWorkspaceTabs(
      [
        { kind: "workspace", folderPath: "/code/nomad", occurrence: 0 },
        { kind: "workspace", folderPath: "/code/nomad", occurrence: 0 },
      ],
      [{ id: "only", folderPath: "/code/nomad" }],
    )

    assert.deepEqual(matches.map((match) => match.existingWorkspaceId), ["only", null])
  })

  it("falls back to a valid parent when the active session is stale", () => {
    assert.deepEqual(
      resolveRestoredSessionSelection(
        [
          { id: "parent", parentId: null },
          { id: "child", parentId: "parent" },
        ],
        "parent",
        "deleted-child",
      ),
      { parentSessionId: "parent", activeSessionId: "parent" },
    )
  })

  it("restores a grandchild under its root session", () => {
    assert.deepEqual(
      resolveRestoredSessionSelection(
        [
          { id: "root", parentId: null },
          { id: "child", parentId: "root" },
          { id: "grandchild", parentId: "child" },
        ],
        "root",
        "grandchild",
      ),
      { parentSessionId: "root", activeSessionId: "grandchild" },
    )
  })

  it("rejects ancestry with a cycle or missing parent", () => {
    assert.equal(
      resolveRestoredSessionSelection([
        { id: "first", parentId: "second" },
        { id: "second", parentId: "first" },
      ], null, "first"),
      null,
    )
    assert.equal(
      resolveRestoredSessionSelection([{ id: "orphan", parentId: "missing" }], null, "orphan"),
      null,
    )
  })

  it("treats missing saved session references as unsafe", () => {
    const sessions = [{ id: "loaded", parentId: null }]
    assert.equal(areRestoredSessionReferencesAvailable(sessions, {
      activeParentSessionId: "loaded",
      activeSessionId: "info",
      draftSessionIds: ["loaded", "__no_session_draft__"],
      attachmentSessionIds: ["loaded"],
      scrollSessionIds: ["loaded"],
    }, ["__no_session_draft__"]), true)
    assert.equal(areRestoredSessionReferencesAvailable(sessions, {
      activeParentSessionId: "missing-parent",
      activeSessionId: "missing-active",
      draftSessionIds: ["missing-draft"],
      attachmentSessionIds: ["missing-attachment"],
      scrollSessionIds: ["missing-scroll"],
    }), false)
    assert.deepEqual(
      [...getUnavailableRestoredSessionIds(sessions, {
        activeSessionId: "missing-active",
        draftSessionIds: ["missing-draft"],
        attachmentSessionIds: ["missing-attachment"],
        scrollSessionIds: ["loaded"],
      })],
      ["missing-active", "missing-draft", "missing-attachment"],
    )
  })

  it("keeps the special info selection without requiring a session", () => {
    assert.deepEqual(resolveRestoredSessionSelection([], null, "info"), {
      parentSessionId: null,
      activeSessionId: "info",
    })
  })

  it("falls back to the first restored tab when the active SideCar failed", () => {
    assert.equal(resolveRestoredActiveTabId(["instance:workspace", null, "sidecar:other"], 1), "instance:workspace")
  })

  it("does not restore for secondary or disabled clients", () => {
    const snapshot = { tabs: [] }
    assert.equal(shouldRestoreSessionState(false, true, snapshot), false)
    assert.equal(shouldRestoreSessionState(true, false, snapshot), false)
    assert.equal(shouldRestoreSessionState(true, true, null), false)
    assert.equal(shouldRestoreSessionState(true, true, snapshot), true)
  })

  it("keeps capture enabled after partial or timed-out restoration", () => {
    assert.equal(shouldEnableSessionCapture(true, false), true)
    assert.equal(shouldEnableSessionCapture(true, true), true)
    assert.equal(shouldEnableSessionCapture(false, false), true)
  })
})
