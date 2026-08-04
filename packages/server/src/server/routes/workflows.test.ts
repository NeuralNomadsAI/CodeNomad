import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"
import { WORKFLOW_DEFINITION_REVISION_LIMIT } from "../../workflows/definition-schema"
import { WorkflowRunError, type WorkflowManager } from "../../workflows/manager"
import { registerWorkflowRoutes } from "./workflows"

describe("workflow routes", () => {
  it("rejects generic plugin starts and scopes plugin requests to their workspace", async () => {
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

    const rejected = await app.inject({
      method: "POST",
      url: "/workspaces/workspace-a/plugin/workflow-runs",
      payload: {
        objective: "Ship it",
        stages: [{ id: "build", title: "Build", instructions: "Implement" }],
      },
    })
    assert.equal(rejected.statusCode, 404)
    assert.equal(calls.length, 0)

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

  it("exposes definition CRUD to host routes and only read/start to a workspace plugin", async () => {
    const calls: Array<[string, ...unknown[]]> = []
    const record = { id: "deploy", revision: 2, definition: { id: "deploy", name: "Deploy" } }
    const workflowManager = {
      listDefinitions: async () => [record],
      getDefinition: async (id: string, revision?: number) => { calls.push(["get", id, revision]); return record },
      createDefinition: async (source: unknown) => { calls.push(["create", source]); return record },
      updateDefinition: async (id: string, revision: number, source: unknown) => { calls.push(["update", id, revision, source]); return record },
      deleteDefinition: async (id: string, revision: number) => { calls.push(["delete", id, revision]); return true },
      validateDefinition: () => ({ valid: true }),
      start: async (input: unknown) => { calls.push(["start", input]); return { id: "run", workspaceId: "workspace-a" } },
      startLatest: async (input: unknown) => { calls.push(["startLatest", input]); return { id: "run", workspaceId: "workspace-a" } },
      pause: async (id: string) => { calls.push(["pause", id]); return { id } },
      resume: async (id: string, confirm: boolean) => { calls.push(["resume", id, confirm]); return { id } },
      answer: async (id: string, executionNodeId: string, answer: unknown) => { calls.push(["answer", id, executionNodeId, answer]); return { id } },
    } as unknown as WorkflowManager
    const app = Fastify({ logger: false })
    registerWorkflowRoutes(app, { workflowManager })

    assert.equal((await app.inject({ method: "GET", url: "/workspaces/workspace-a/plugin/workflow-definitions" })).statusCode, 200)
    assert.equal((await app.inject({ method: "POST", url: "/workspaces/workspace-a/plugin/workflow-definitions", payload: {
      source: "version: 1",
    } })).statusCode, 404)
    assert.equal((await app.inject({ method: "PUT", url: "/workspaces/workspace-a/plugin/workflow-definitions/deploy", payload: {
      expectedRevision: 2, definition: { version: 1 },
    } })).statusCode, 404)
    const started = await app.inject({
      method: "POST", url: "/workspaces/workspace-a/plugin/workflow-definitions/deploy/start",
      payload: { objective: "Release", inputs: { environment: "test" } },
    })
    assert.equal(started.statusCode, 202)
    assert.deepEqual(calls.at(-1), ["start", {
      workspaceId: "workspace-a", definitionId: "deploy", objective: "Release",
      inputs: { environment: "test" },
    }])
    assert.equal((await app.inject({
      method: "POST",
      url: "/workspaces/workspace-a/plugin/workflow-runs",
      payload: {
        initiatorSessionId: "parent-session",
        objective: "Ship it",
        stages: [{ id: "build", title: "Build", instructions: "Implement" }],
      },
    })).statusCode, 404)
    assert.equal((await app.inject({
      method: "POST", url: "/workspaces/workspace-a/plugin/workflow-definitions/deploy/start",
      payload: { worktree: { mode: "existing", slug: "review" } },
    })).statusCode, 400)
    assert.equal((await app.inject({
      method: "POST", url: "/workspaces/workspace-a/plugin/workflow-definitions/deploy/start",
      payload: { initiatorSessionId: "victim-session" },
    })).statusCode, 400)
    assert.equal((await app.inject({
      method: "POST", url: "/api/workflow-definitions/deploy/start",
      payload: { workspaceId: "workspace-a", worktree: { mode: "current", slug: "not-allowed" } },
    })).statusCode, 400)
    assert.equal((await app.inject({
      method: "POST", url: "/workspaces/workspace-a/plugin/workflow-definitions/deploy/start",
      payload: { definitionRevision: 1 },
    })).statusCode, 400)
    assert.equal((await app.inject({
      method: "POST", url: "/workspaces/workspace-a/plugin/workflow-runs",
      payload: { definitionId: "deploy" },
    })).statusCode, 404)
    assert.equal((await app.inject({
      method: "DELETE", url: "/workspaces/workspace-a/plugin/workflow-definitions/deploy?expectedRevision=2",
    })).statusCode, 404)
    assert.equal((await app.inject({
      method: "POST", url: "/workspaces/workspace-a/plugin/workflow-runs/00000000-0000-4000-8000-000000000001/answer",
      payload: { answer: true },
    })).statusCode, 404)

    assert.equal((await app.inject({
      method: "PUT", url: "/api/workflow-definitions/deploy",
      payload: { expectedRevision: 2, definition: { version: 1 } },
    })).statusCode, 200)
    assert.deepEqual(calls.at(-1), ["update", "deploy", 2, { version: 1 }])
    assert.equal((await app.inject({
      method: "POST", url: "/api/workflow-definitions/deploy/start",
      payload: { workspaceId: "workspace-a", definitionRevision: 2, inputs: { environment: "prod" } },
    })).statusCode, 202)
    assert.deepEqual(calls.at(-1), ["startLatest", {
      workspaceId: "workspace-a", definitionId: "deploy", definitionRevision: 2, inputs: { environment: "prod" },
    }])
    assert.equal((await app.inject({
      method: "POST", url: "/api/workflow-runs/00000000-0000-4000-8000-000000000001/answer",
      payload: { executionNodeId: "00000000-0000-4000-8000-000000000002", answer: { approved: true } },
    })).statusCode, 200)
    assert.deepEqual(calls.at(-1), ["answer", "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", { approved: true }])
    await app.close()
  })

  it("keeps legacy and definition starts exclusive and enforces atomic latest revisions", async () => {
    const calls: Array<[string, unknown]> = []
    const workflowManager = {
      getDefinition: async () => ({ id: "deploy", revision: 2, definition: { id: "deploy" } }),
      start: async (input: unknown) => { calls.push(["start", input]); return { id: "legacy" } },
      startLatest: async (input: { definitionRevision?: number }) => {
        if (input.definitionRevision !== undefined && input.definitionRevision !== 2) {
          throw new WorkflowRunError("Workflow definition revision is stale", 409)
        }
        calls.push(["startLatest", input])
        return { id: "saved" }
      },
    } as unknown as WorkflowManager
    const app = Fastify({ logger: false })
    registerWorkflowRoutes(app, { workflowManager })

    const legacy = {
      workspaceId: "workspace", objective: "Ship",
      stages: [{ id: "build", title: "Build", instructions: "Build it" }],
    }
    assert.equal((await app.inject({ method: "POST", url: "/api/workflow-runs", payload: legacy })).statusCode, 202)
    assert.equal((await app.inject({
      method: "POST", url: "/api/workflow-runs", payload: { ...legacy, definitionId: "deploy" },
    })).statusCode, 400)
    assert.equal((await app.inject({
      method: "POST", url: "/api/workflow-runs", payload: {
        ...legacy, stages: [{ ...legacy.stages[0], definitionId: "deploy" }],
      },
    })).statusCode, 400)
    assert.equal((await app.inject({
      method: "POST", url: "/api/workflow-runs", payload: {
        workspaceId: "workspace", definitionId: "deploy", stages: legacy.stages,
      },
    })).statusCode, 400)

    assert.equal((await app.inject({
      method: "POST", url: "/api/workflow-definitions/deploy/start",
      payload: { workspaceId: "workspace", definitionRevision: 1 },
    })).statusCode, 409)
    assert.equal((await app.inject({
      method: "POST", url: "/api/workflow-definitions/deploy/start",
      payload: { workspaceId: "workspace", definitionRevision: 2 },
    })).statusCode, 202)
    assert.deepEqual(calls.at(-1), ["startLatest", {
      workspaceId: "workspace", definitionId: "deploy", definitionRevision: 2,
    }])
    assert.equal((await app.inject({
      method: "POST", url: "/api/workflow-definitions/deploy/start",
      payload: { workspaceId: "workspace", definitionRevision: WORKFLOW_DEFINITION_REVISION_LIMIT + 1 },
    })).statusCode, 400)
    await app.close()
  })

  it("fails closed when atomic latest start manager integration is unavailable", async () => {
    const workflowManager = {
      getDefinition: async () => ({ id: "deploy", revision: 2, definition: { id: "deploy" } }),
      start: async () => { throw new Error("non-atomic start must not be called") },
    } as unknown as WorkflowManager
    const app = Fastify({ logger: false })
    registerWorkflowRoutes(app, { workflowManager })
    const response = await app.inject({
      method: "POST", url: "/api/workflow-definitions/deploy/start",
      payload: { workspaceId: "workspace", definitionRevision: 2 },
    })
    assert.equal(response.statusCode, 501)
    await app.close()
  })

  it("bounds definition inputs and gate answers without recursive validation", async () => {
    const calls: Array<[string, ...unknown[]]> = []
    const workflowManager = {
      start: async (input: unknown) => { calls.push(["start", input]); return { id: "run" } },
      answer: async (...args: unknown[]) => { calls.push(["answer", ...args]); return { id: "run" } },
    } as unknown as WorkflowManager
    const app = Fastify({ logger: false })
    registerWorkflowRoutes(app, { workflowManager })
    const startUrl = "/api/workflow-definitions/deploy/start"
    const pluginStartUrl = "/workspaces/workspace/plugin/workflow-definitions/deploy/start"
    const answerUrl = "/api/workflow-runs/00000000-0000-4000-8000-000000000001/answer"
    const executionNodeId = "00000000-0000-4000-8000-000000000002"

    let nested: unknown = true
    for (let depth = 0; depth < 21; depth++) nested = { nested }
    assert.equal((await app.inject({
      method: "POST", url: pluginStartUrl, payload: { inputs: nested },
    })).statusCode, 400)
    assert.equal((await app.inject({
      method: "POST", url: startUrl,
      payload: { workspaceId: "workspace", inputs: { values: Array(50_001).fill(null) } },
    })).statusCode, 400)
    assert.equal((await app.inject({
      method: "POST", url: startUrl,
      payload: { workspaceId: "workspace", inputs: { value: "é".repeat(128_001) } },
    })).statusCode, 400)
    assert.equal((await app.inject({
      method: "POST", url: answerUrl, payload: { executionNodeId, answer: nested },
    })).statusCode, 400)
    assert.equal(calls.length, 0)

    assert.equal((await app.inject({
      method: "POST", url: answerUrl, payload: { executionNodeId, answer: { approved: true } },
    })).statusCode, 200)
    assert.deepEqual(calls, [["answer", "00000000-0000-4000-8000-000000000001", executionNodeId, { approved: true }]])
    await app.close()
  })

  it("requires the expected legacy stage when approving", async () => {
    const calls: string[] = []
    const workflowManager = {
      approve: async (id: string, expectedStepId: string) => {
        if (expectedStepId !== "review-stage") throw new WorkflowRunError("Workflow approval is stale", 409)
        calls.push(id)
        return { id }
      },
    } as unknown as WorkflowManager
    const app = Fastify({ logger: false })
    registerWorkflowRoutes(app, { workflowManager })
    const url = "/api/workflow-runs/00000000-0000-4000-8000-000000000001/approve"

    assert.equal((await app.inject({ method: "POST", url })).statusCode, 400)
    assert.equal((await app.inject({ method: "POST", url, payload: { expectedStepId: "stale-stage" } })).statusCode, 409)
    assert.equal(calls.length, 0)
    assert.equal((await app.inject({ method: "POST", url, payload: { expectedStepId: "review-stage" } })).statusCode, 200)
    assert.deepEqual(calls, ["00000000-0000-4000-8000-000000000001"])
    await app.close()
  })

  it("requires a revision-bound recovery confirmation", async () => {
    const calls: unknown[][] = []
    const workflowManager = {
      resume: async (...args: unknown[]) => { calls.push(args); return { id: args[0] } },
    } as unknown as WorkflowManager
    const app = Fastify({ logger: false })
    registerWorkflowRoutes(app, { workflowManager })
    const url = "/api/workflow-runs/00000000-0000-4000-8000-000000000001/resume"

    assert.equal((await app.inject({ method: "POST", url, payload: { confirmRecovery: true } })).statusCode, 400)
    assert.equal((await app.inject({ method: "POST", url, payload: { expectedRevision: 4 } })).statusCode, 400)
    assert.equal((await app.inject({ method: "POST", url, payload: {
      confirmRecovery: true, expectedRevision: 4,
    } })).statusCode, 200)
    assert.deepEqual(calls, [["00000000-0000-4000-8000-000000000001", true, 4]])
    await app.close()
  })

  it("cancels plugin-owned runs without joining get", async () => {
    const calls: unknown[][] = []
    const workflowManager = {
      get: async () => { throw new Error("get must not be called") },
      cancelOwned: async (...args: unknown[]) => {
        calls.push(args)
        return { id: args[0], workspaceId: args[1], status: "cancelled" }
      },
    } as unknown as WorkflowManager
    const app = Fastify({ logger: false })
    registerWorkflowRoutes(app, { workflowManager })

    const response = await app.inject({
      method: "POST",
      url: "/workspaces/workspace-a/plugin/workflow-runs/00000000-0000-4000-8000-000000000001/cancel",
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(calls, [["00000000-0000-4000-8000-000000000001", "workspace-a"]])
    await app.close()
  })
})
