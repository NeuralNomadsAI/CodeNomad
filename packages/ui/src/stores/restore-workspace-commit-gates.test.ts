import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { WorkspaceDescriptor } from "../../../server/src/api-types.ts"
import { RestoreWorkspaceCommitGates } from "./restore-workspace-commit-gates.ts"

const workspace = (
  status: WorkspaceDescriptor["status"],
  updatedAt: string,
  values: Partial<WorkspaceDescriptor> = {},
): WorkspaceDescriptor => ({
  id: "workspace-1", requestId: "request-1", path: "/work", name: "work", status,
  proxyPath: "", binaryId: "opencode", binaryLabel: "OpenCode", createdAt: "2026-01-01T00:00:00Z",
  updatedAt, ...values,
})

describe("restore workspace commit gates", () => {
  it("old response/finally cannot bind or erase a replacement using the same request ID", () => {
    const gates = new RestoreWorkspaceCommitGates<WorkspaceDescriptor>()
    const oldOwner = () => false, newOwner = () => true
    gates.begin("r", Promise.resolve(), "/work", "B", oldOwner)
    gates.begin("r", Promise.resolve(), "/work", "B", newOwner)
    gates.bindResponse("r", "B~old", oldOwner)
    gates.end("r", "B", oldOwner)
    const b = workspace("ready", "", { id: "B~w", requestId: "r" })
    assert.equal(gates.deferWorkspace(b), true)
    assert.equal(gates.resolve("r", b, "B", newOwner).workspace, b)
    assert.equal(gates.deferStopped("B~old"), false)
  })
  it("fences stopped receipts by attachment and retains a replacement's early stop through old cleanup", () => {
    const gates = new RestoreWorkspaceCommitGates<WorkspaceDescriptor>()
    let oldCurrent = true
    gates.begin("old", Promise.resolve(), "/work", "B", () => oldCurrent)
    gates.deferStopped("B~old", "old stop")
    gates.bindResponse("old", "B~w")
    oldCurrent = false
    gates.begin("new", Promise.resolve(), "/work", "B")
    gates.deferStopped("B~w", "new stop")
    gates.end("old", "B")
    gates.bindResponse("new", "B~w")
    assert.equal(gates.resolve("new", workspace("ready", "", { id: "B~w" })).terminal?.message, "new stop")
    gates.bindResponse("new", "B~old")
    assert.equal(gates.resolve("new", workspace("ready", "", { id: "B~w" })).terminal?.message, "new stop")
  })
  it("never gates a replacement attachment behind the revoked owner", () => {
    const gates = new RestoreWorkspaceCommitGates<WorkspaceDescriptor>()
    let current = true
    gates.begin("request-1", Promise.resolve(), "/work", "B", () => current)
    const b = workspace("ready", "2026-01-01T00:00:03Z", { id: "B~workspace-1" })
    assert.equal(gates.deferWorkspace(b), true)
    current = false
    assert.equal(gates.deferRefreshWorkspace(b), false)
    assert.equal(gates.deferStopped(b.id), false)
    assert.equal(gates.resolve("request-1", b).terminal, undefined)
  })
  it("isolates identical request IDs and physical paths by backend", () => {
    const gates = new RestoreWorkspaceCommitGates<WorkspaceDescriptor>()
    gates.begin("request-1", Promise.resolve(), "/work", "A")
    const b = workspace("ready", "2026-01-01T00:00:03Z", { id: "B~workspace-1" })
    assert.equal(gates.deferRefreshWorkspace(b), false)
    gates.begin("request-1", Promise.resolve(), "/work", "B")
    assert.equal(gates.deferWorkspace(b), true)
    gates.end("request-1", "A")
    assert.equal(gates.resolve("request-1", b, "B").workspace, b)
    assert.equal(gates.deferStopped("A~workspace-1"), false)
    assert.equal(gates.resolve("request-1", b, "B").terminal, undefined)
  })
  it("keeps the newest descriptor while a restore response races native events", () => {
    const gates = new RestoreWorkspaceCommitGates<WorkspaceDescriptor>()
    gates.begin("request-1", Promise.resolve())
    assert.equal(gates.deferWorkspace(workspace("starting", "2026-01-01T00:00:01Z")), true)
    const response = workspace("ready", "2026-01-01T00:00:02Z", { port: 3000 })
    assert.equal(gates.resolve("request-1", response).workspace, response)
    const event = workspace("ready", "2026-01-01T00:00:03Z", { port: 4000 })
    gates.deferWorkspace(event)
    assert.equal(gates.resolve("request-1", response).workspace, event)
  })

  it("correlates a stopped event that arrives before the HTTP response binds its workspace ID", () => {
    const gates = new RestoreWorkspaceCommitGates<WorkspaceDescriptor>()
    gates.begin("request-1", Promise.resolve())
    assert.equal(gates.deferStopped("workspace-1", "stopped before response"), false)
    gates.bindResponse("request-1", "workspace-1")
    assert.deepEqual(gates.resolve("request-1", workspace("ready", "2026-01-01T00:00:02Z")).terminal,
      { status: "stopped", message: "stopped before response" })
  })
})
