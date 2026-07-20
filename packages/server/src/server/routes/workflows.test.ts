import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"
import type { WorkflowManager } from "../../workflows/manager"
import { registerWorkflowRoutes } from "./workflows"

describe("workflow routes", () => {
  it("validates generic stages and scopes plugin requests to their workspace", async () => {
    const calls: unknown[] = []
    const workflowManager = {
      start: async (input: unknown) => {
        calls.push(input)
        return { id: "00000000-0000-4000-8000-000000000001", workspaceId: "workspace-a", status: "running" }
      },
      list: async () => [],
      get: async () => ({ id: "run", workspaceId: "workspace-b" }),
    } as unknown as WorkflowManager
    const app = Fastify({ logger: false })
    registerWorkflowRoutes(app, { workflowManager })

    const duplicate = await app.inject({
      method: "POST",
      url: "/workspaces/workspace-a/plugin/workflow-runs",
      payload: {
        objective: "Ship it",
        stages: [
          { id: "same", title: "One", instructions: "First" },
          { id: "same", title: "Two", instructions: "Second" },
        ],
      },
    })
    assert.equal(duplicate.statusCode, 400)
    assert.equal(calls.length, 0)

    const created = await app.inject({
      method: "POST",
      url: "/workspaces/workspace-a/plugin/workflow-runs",
      payload: { objective: "Ship it", stages: [{ id: "build", title: "Build", instructions: "Implement" }] },
    })
    assert.equal(created.statusCode, 202)
    assert.deepEqual(calls, [{
      workspaceId: "workspace-a",
      objective: "Ship it",
      stages: [{ id: "build", title: "Build", instructions: "Implement" }],
    }])

    const foreign = await app.inject({
      method: "GET",
      url: "/workspaces/workspace-a/plugin/workflow-runs/00000000-0000-4000-8000-000000000001",
    })
    assert.equal(foreign.statusCode, 404)

    const pluginApproval = await app.inject({
      method: "POST",
      url: "/workspaces/workspace-a/plugin/workflow-runs/00000000-0000-4000-8000-000000000001/approve",
    })
    assert.equal(pluginApproval.statusCode, 404)
    await app.close()
  })
})
