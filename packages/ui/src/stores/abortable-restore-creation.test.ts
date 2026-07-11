import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  completeAbortableRestoreCreation,
  completeAbortableRestoreHydration,
} from "./abortable-restore-creation.ts"
import {
  createRestorableSessionPreservation,
  mapRestoredWorkspace,
  mergeRestorableSessionState,
  unmapRestoredWorkspace,
} from "./app-session-snapshot-merge.ts"

describe("abortable restore creation", () => {
  it("discards a workspace that completes after cancellation without committing it", async () => {
    let finish: ((value: { id: string }) => void) | undefined
    const creation = new Promise<{ id: string }>((resolve) => {
      finish = resolve
    })
    const controller = new AbortController()
    let committed = false
    const discarded: string[] = []
    const result = completeAbortableRestoreCreation(creation, {
      signal: controller.signal,
      commit: () => {
        committed = true
      },
      discard: async (workspace) => {
        discarded.push(workspace.id)
      },
    })

    controller.abort(new Error("restore timed out"))
    finish?.({ id: "late-workspace" })
    await assert.rejects(result, /restore timed out/)
    assert.equal(committed, false)
    assert.deepEqual(discarded, ["late-workspace"])
  })

  it("disposes a committed restore workspace when hydration is aborted before state application", async () => {
    const controller = new AbortController()
    const disposed: string[] = []
    let creationCommitted = false
    let preservation = createRestorableSessionPreservation({
      tabs: [{
        kind: "workspace",
        folder: "/restore",
        occurrence: 0,
        drafts: { missing: "preserve through cancellation" },
        attachments: {},
        scrollSnapshots: {},
        unseenIdleSince: {},
      }],
      activeTabIndex: 0,
    })
    const created = await completeAbortableRestoreCreation(Promise.resolve({ id: "restore-workspace" }), {
      signal: controller.signal,
      commit: (workspace) => {
        creationCommitted = true
        preservation = mapRestoredWorkspace(preservation, 0, `instance:${workspace.id}`)
      },
      discard: async (workspace) => {
        preservation = unmapRestoredWorkspace(preservation, `instance:${workspace.id}`)
        disposed.push(workspace.id)
      },
    })
    assert.equal(creationCommitted, true)
    assert.equal(preservation.restoredWorkspaceSourceIndexes.get("instance:restore-workspace"), 0)

    let finishHydration: (() => void) | undefined
    const hydration = new Promise<void>((resolve) => {
      finishHydration = resolve
    })
    let restoredTabId: string | null = null
    let restoredStateApplied = false

    const completion = completeAbortableRestoreHydration(created, {
      signal: controller.signal,
      hydrate: () => hydration,
      commit: (workspace) => {
        restoredTabId = `instance:${workspace.id}`
        restoredStateApplied = true
      },
      discard: async (workspace) => {
        preservation = unmapRestoredWorkspace(preservation, `instance:${workspace.id}`)
        disposed.push(workspace.id)
      },
    })

    controller.abort(new Error("restore timed out during hydration"))
    await assert.rejects(completion, /restore timed out during hydration/)
    assert.deepEqual(disposed, ["restore-workspace"])
    assert.equal(restoredTabId, null)
    assert.equal(restoredStateApplied, false)
    assert.equal(preservation.restoredWorkspaceSourceIndexes.size, 0)
    const cancelled = mergeRestorableSessionState({ tabs: [], activeTabIndex: -1 }, preservation)
    assert.equal(cancelled.tabs.length, 1)
    assert.equal(
      cancelled.tabs[0]?.kind === "workspace" ? cancelled.tabs[0].drafts.missing : undefined,
      "preserve through cancellation",
    )

    finishHydration?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(restoredTabId, null)
    assert.equal(restoredStateApplied, false)
  })
})
