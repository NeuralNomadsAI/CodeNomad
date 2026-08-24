import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
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
  it("integrates refresh and terminal events without bypassing the gate", () => {
    const source = readFileSync(new URL("./instances.ts", import.meta.url), "utf8")
    const refresh = source.slice(source.indexOf("async function refreshWorkspaceList"), source.indexOf("const initialWorkspaceLoad"))
    assert.ok(refresh.indexOf("restoreCreationCommitGates.deferRefreshWorkspace(workspace)") < refresh.indexOf("upsertWorkspace(workspace)"))
    assert.match(source, /restoreCreationCommitGates\.deferStopped\(event\.workspaceId, event\.reason\)/)
    assert.match(source, /settleRestoreWorkspaceTerminal\(committedWorkspace, terminal\)/)
  })

  it("defers refresh/SSE descriptors and prefers a ready HTTP response over stale created state", () => {
    const gates = new RestoreWorkspaceCommitGates<WorkspaceDescriptor>()
    gates.begin("request-1", Promise.resolve())
    assert.equal(gates.deferWorkspace(workspace("starting", "2026-01-01T00:00:01Z")), true)
    const response = workspace("ready", "2026-01-01T00:00:02Z", { port: 3000 })
    assert.equal(gates.resolve("request-1", response).workspace, response)
  })

  it("defers a refresh descriptor without request correlation when its path is gated", () => {
    const gates = new RestoreWorkspaceCommitGates<WorkspaceDescriptor>()
    gates.begin("request-1", Promise.resolve(), String.raw`C:\Work`)
    const refresh = workspace("starting", "2026-01-01T00:00:01Z", {
      requestId: undefined, path: "c:/work/",
    })
    assert.equal(gates.deferRefreshWorkspace(refresh), true)
    assert.equal(gates.resolve("request-1", workspace("ready", "2026-01-01T00:00:02Z")).workspace.status, "ready")
  })

  it("uses a newer equally-advanced SSE descriptor", () => {
    const gates = new RestoreWorkspaceCommitGates<WorkspaceDescriptor>()
    gates.begin("request-1", Promise.resolve())
    const response = workspace("ready", "2026-01-01T00:00:02Z", { port: 3000 })
    const event = workspace("ready", "2026-01-01T00:00:03Z", { port: 4000 })
    gates.deferWorkspace(event)
    assert.equal(gates.resolve("request-1", response).workspace, event)
  })

  it("retains error and stopped terminals until create handling resolves them", () => {
    const gates = new RestoreWorkspaceCommitGates<WorkspaceDescriptor>()
    gates.begin("request-1", Promise.resolve())
    gates.deferWorkspace(workspace("starting", "2026-01-01T00:00:01Z"))
    assert.equal(gates.deferStopped("workspace-1", "server stopped"), true)
    assert.deepEqual(gates.resolve("request-1", workspace("ready", "2026-01-01T00:00:02Z")).terminal,
      { status: "stopped", message: "server stopped" })
    gates.end("request-1")
    assert.equal(gates.deferStopped("workspace-1"), false, "terminal events are handled normally after commit")
  })

  it("correlates a stopped event that arrives before the HTTP response binds its workspace ID", () => {
    const gates = new RestoreWorkspaceCommitGates<WorkspaceDescriptor>()
    gates.begin("request-1", Promise.resolve())
    assert.equal(gates.deferStopped("workspace-1", "stopped before response"), false)
    gates.bindResponse("request-1", "workspace-1")
    assert.deepEqual(gates.resolve("request-1", workspace("ready", "2026-01-01T00:00:02Z")).terminal,
      { status: "stopped", message: "stopped before response" })
  })

  it("retains a correlated workspace error over a ready response", () => {
    const gates = new RestoreWorkspaceCommitGates<WorkspaceDescriptor>()
    gates.begin("request-1", Promise.resolve())
    gates.deferWorkspace(workspace("error", "2026-01-01T00:00:03Z", { error: "launch failed" }))
    const resolved = gates.resolve("request-1", workspace("ready", "2026-01-01T00:00:02Z"))
    assert.equal(resolved.workspace.status, "error")
    assert.deepEqual(resolved.terminal, { status: "error", message: "launch failed" })
  })
})
