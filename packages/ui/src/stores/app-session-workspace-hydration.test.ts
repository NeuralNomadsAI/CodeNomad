import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

describe("restored workspace hydration", () => {
  it("seeds scroll snapshots before publishing restored session selection", () => {
    const source = readFileSync(new URL("./app-session-workspace-hydration.ts", import.meta.url), "utf8")
    const hydrate = source.slice(source.indexOf("export async function hydrateRestoredWorkspaceState"))
    const abortIndex = hydrate.indexOf("if (signal.aborted) throw getAbortReason(signal)")
    const bindingIndex = hydrate.indexOf("if (!isCurrentBinding()) return null")
    const seedIndex = hydrate.indexOf("seedRestoredWorkspaceScrollSnapshots(instanceId, snapshot)")
    const sessionHydrationIndex = hydrate.indexOf("await hydrateRestoredSessionChain")
    const selectionIndex = hydrate.indexOf("hydrateActiveSessionSelection(instanceId")

    assert.notEqual(abortIndex, -1)
    assert.notEqual(bindingIndex, -1)
    assert.notEqual(seedIndex, -1)
    assert.notEqual(sessionHydrationIndex, -1)
    assert.notEqual(selectionIndex, -1)
    assert.ok(abortIndex < seedIndex, "cancelled restoration must not seed scroll state")
    assert.ok(bindingIndex < seedIndex, "stale workspace bindings must not seed scroll state")
    assert.ok(seedIndex < sessionHydrationIndex, "scroll authority must not wait for session network hydration")
    assert.ok(seedIndex < selectionIndex, "scroll authority must exist before MessageSection can mount")
  })

  it("seeds existing workspaces before restoring the active app tab", () => {
    const source = readFileSync(new URL("../lib/hooks/use-app-session-restore.ts", import.meta.url), "utf8")
    const existingSeedIndex = source.indexOf("seedRestoredWorkspaceScrollSnapshots(existingWorkspaceId!, tab)")
    const applyOrderIndex = source.indexOf("context.applyOrder()")
    const selectActiveIndex = source.indexOf("context.selectActive(provisionalId")

    assert.notEqual(existingSeedIndex, -1)
    assert.ok(existingSeedIndex < applyOrderIndex, "existing workspace scroll state must precede restored tab ordering")
    assert.ok(existingSeedIndex < selectActiveIndex, "existing workspace scroll state must exist before its tab mounts")
  })

  it("seeds created workspaces before their runtime commit mounts the tab", () => {
    const restore = readFileSync(new URL("../lib/hooks/use-app-session-restore.ts", import.meta.url), "utf8")
    const instances = readFileSync(new URL("./instances.ts", import.meta.url), "utf8")

    assert.match(restore, /onBeforeCreateCommit: \(id\) => seedRestoredWorkspaceScrollSnapshots\(id, tab\)/)
    assert.ok(
      instances.indexOf("options?.onBeforeCreateCommit?.(workspace.id)") < instances.indexOf("upsertWorkspace(committedWorkspace"),
      "created workspace scroll state must exist before upsert mounts InstanceShell",
    )
  })

  it("retries an initial no-snapshot render when the native scroll seed arrives", () => {
    const section = readFileSync(new URL("../components/message-section.tsx", import.meta.url), "utf8")
    const snapshotIndex = section.indexOf("const snapshot = initialScrollSnapshot()")
    const settledGuardIndex = section.indexOf("if (didRestoreScroll() && (!restoredWithoutSnapshot || !snapshot)) return")

    assert.notEqual(snapshotIndex, -1)
    assert.ok(snapshotIndex < settledGuardIndex, "the restore effect must observe a late snapshot before its settled guard")
    assert.match(section, /restoredWithoutSnapshot = true\s+setDidRestoreScroll\(true\)/)
    assert.match(section, /restoredWithoutSnapshot = false\s+const restoreSessionId/)
  })
})
