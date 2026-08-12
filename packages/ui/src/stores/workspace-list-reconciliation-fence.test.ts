import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { WorkspaceListReconciliationFence } from "./workspace-list-reconciliation-fence.ts"

describe("workspace list reconciliation fence", () => {
  it("is wired before restore gates and event early returns", () => {
    const source = readFileSync(new URL("./instances.ts", import.meta.url), "utf8")
    const refresh = source.slice(source.indexOf("async function refreshWorkspaceList"), source.indexOf("const initialWorkspaceLoad"))
    assert.ok(refresh.indexOf("workspaceListReconciliationFence.allows(requestFence, workspace.id)")
      < refresh.indexOf("restoreCreationCommitGates.deferRefreshWorkspace(workspace)"))
    const events = source.slice(source.indexOf("function handleWorkspaceEvent"), source.indexOf("function handleWorkspaceLog"))
    assert.ok(events.indexOf("workspaceListReconciliationFence.markMutation(workspaceId)")
      < events.indexOf("restoreCreationCommitGates.deferWorkspace(event.workspace)"))
    const create = source.slice(source.indexOf("async function createInstance"), source.indexOf("function normalizeInstanceFolderPath"))
    assert.ok(create.indexOf("workspaceListReconciliationFence.markMutation(workspace.id)")
      < create.indexOf("upsertWorkspace(committedWorkspace"))
    const stop = source.slice(source.indexOf("function stopInstance"), source.indexOf("async function fetchLspStatus"))
    assert.ok(stop.indexOf("await serverApi.deleteWorkspace(id)") < stop.indexOf("releaseInstanceResources(id)"))
    assert.ok(stop.indexOf("workspaceListReconciliationFence.markMutation(id)") < stop.indexOf("removeInstance(id)"))
  })

  it("does not treat host workflow updates as OpenCode stream connectivity", () => {
    const source = readFileSync(new URL("./instances.ts", import.meta.url), "utf8")
    const events = source.slice(source.indexOf('serverEvents.on("instance.event",'), source.indexOf("function createRestoreCreationRequestId"))
    assert.match(events, /event\.event\.type === "workflow\.run\.updated"/)
    assert.match(events, /openCodeConnectionStatuses\.get\(event\.instanceId\) \?\? "disconnected"/)
  })

  it("rejects stale list entries and absences after lifecycle mutations", () => {
    const fence = new WorkspaceListReconciliationFence()
    const request = fence.begin()
    for (const id of ["created", "started", "errored", "stopped", "deleted"]) fence.markMutation(id)
    for (const id of ["created", "started", "errored", "stopped", "deleted"]) {
      assert.equal(fence.allows(request, id), false)
    }
    assert.equal(fence.allows(request, "unchanged"), true)
  })

  it("rejects an older response after a newer list request starts", () => {
    const fence = new WorkspaceListReconciliationFence()
    const older = fence.begin()
    const newer = fence.begin()
    assert.equal(fence.isCurrent(older), false)
    assert.equal(fence.allows(older, "workspace"), false)
    assert.equal(fence.allows(newer, "workspace"), true)
  })

  it("accepts state that changed before the request and resets after completion", () => {
    const fence = new WorkspaceListReconciliationFence()
    fence.markMutation("workspace")
    const request = fence.begin()
    assert.equal(fence.allows(request, "workspace"), true)
    fence.complete(request)
    assert.equal(fence.allows(fence.begin(), "workspace"), true)
  })
})
