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
