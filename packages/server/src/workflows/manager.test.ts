import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import type { WorkspaceManager } from "../workspaces/manager"
import { WorkflowManager } from "./manager"

describe("WorkflowManager", () => {
  it("admits one run per path or lineage across manager instances", async () => {
    for (const collision of ["lineage", "path"] as const) {
      const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), `codenomad-workflow-shared-${collision}-`))
      let sessions = 0
      const client = { session: {
        create: async () => ({ data: { id: `shared-${++sessions}` } }),
        prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "Review" }] } }),
        abort: async () => ({ data: true }),
      } } as unknown as OpencodeClient
      const workspaceManager = {
        get: (id: string) => ({
          id,
          lineageId: collision === "lineage" ? "shared-lineage" : `lineage-${id}`,
          path: collision === "path" ? "C:/shared-workspace" : `C:/${id}`,
          status: "ready",
        }),
        list: () => [],
      } as unknown as WorkspaceManager
      const options = {
        workspaceManager,
        eventBus: { publish: () => true } as unknown as EventBus,
        logger: { warn() {}, error() {} } as unknown as Logger,
        storageDir,
        createClient: () => client,
      }
      const first = new WorkflowManager(options)
      const second = new WorkflowManager(options)
      try {
        await Promise.all([first.list(), second.list()])
        const starts = await Promise.allSettled([
          first.start({ workspaceId: "first", objective: "First", stages: [
            { id: "work", title: "Work", instructions: "Work", requiresApproval: true },
          ] }),
          second.start({ workspaceId: "second", objective: "Second", stages: [
            { id: "work", title: "Work", instructions: "Work", requiresApproval: true },
          ] }),
        ])
        assert.equal(starts.filter((result) => result.status === "fulfilled").length, 1)
        assert.match((starts.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message, /already running/)
      } finally {
        await Promise.allSettled([first.shutdown(), second.shutdown()])
        await fs.rm(storageDir, { recursive: true, force: true })
      }
    }
  })

  it("rejects a stale saved definition inside the admission queue", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-latest-"))
    const manager = new WorkflowManager({
      workspaceManager: { list: () => [] } as unknown as WorkspaceManager,
      eventBus: { publish: () => true } as unknown as EventBus,
      logger: { warn() {}, error() {} } as unknown as Logger,
      storageDir,
      createClient: () => null,
    })
    try {
      const definition = { version: 1 as const, id: "latest", name: "Latest", root: {
        type: "agent" as const, id: "work", instructions: "Work",
      } }
      await manager.createDefinition(definition)
      await manager.listDefinitions()
      const [updated, stale] = await Promise.allSettled([
        manager.updateDefinition("latest", 1, { ...definition, name: "Updated" }),
        manager.startLatest({ workspaceId: "workspace", definitionId: "latest", definitionRevision: 1 }),
      ])
      assert.equal(updated.status, "fulfilled")
      assert.equal(stale.status, "rejected")
      assert.match((stale as PromiseRejectedResult).reason.message, /revision is stale/)
    } finally {
      await manager.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("resolves an omitted latest revision inside admission", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-current-"))
    let sessions = 0
    const client = { session: {
      create: async () => ({ data: { id: `latest-${++sessions}` } }),
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({
      workspaceManager: {
        get: () => ({ id: "workspace", lineageId: "lineage", path: "C:/workspace", status: "ready" }),
        list: () => [{ id: "workspace", lineageId: "lineage", path: "C:/workspace", status: "ready" }],
      } as unknown as WorkspaceManager,
      eventBus: { publish: () => true } as unknown as EventBus,
      logger: { warn() {}, error() {} } as unknown as Logger,
      storageDir,
      createClient: () => client,
    })
    try {
      const definition = { version: 1 as const, id: "current", name: "Current", root: {
        type: "gate" as const, id: "gate", gate: "approval" as const, prompt: "Wait",
      } }
      await manager.createDefinition(definition)
      const [updated, started] = await Promise.all([
        manager.updateDefinition("current", 1, { ...definition, name: "Updated" }),
        manager.startLatest({ workspaceId: "workspace", definitionId: "current" }),
      ])
      assert.equal(updated.revision, 2)
      assert.equal(started.definitionRevision, 2)
      assert.equal(started.definitionSnapshot?.name, "Updated")
    } finally {
      await manager.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("retries transient creation cleanup on later admission", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-cleanup-"))
    let attempts = 0
    const manager = new WorkflowManager({
      workspaceManager: {
        list: () => [],
        cancelCreationRequest: async () => {
          if (++attempts === 1) throw new Error("transient cleanup failure")
        },
      } as unknown as WorkspaceManager,
      eventBus: { publish: () => true } as unknown as EventBus,
      logger: { warn() {}, error() {} } as unknown as Logger,
      storageDir,
    })
    try {
      ;(manager as any).deferCreationCleanup("request")
      await (manager as any).drainCreationCleanups()
      assert.equal(attempts, 1)
      assert.equal((manager as any).deferredCreationCleanups.has("request"), true)
      await assert.rejects(manager.startLatest({ workspaceId: "workspace", definitionId: "missing" }), /not found/)
      assert.equal(attempts, 2)
      assert.equal((manager as any).deferredCreationCleanups.size, 0)
    } finally {
      await manager.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("persists and hands a structured planner result to the implementer", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflows-"))
    const creates: Array<Record<string, unknown> | undefined> = []
    const prompts: Array<Record<string, unknown>> = []
    let session = 0
    const client = {
      session: {
        create: async (input?: Record<string, unknown>) => {
          creates.push(input)
          return { data: { id: `session-${++session}` } }
        },
        prompt: async (input: Record<string, unknown>) => {
          prompts.push(input)
          if (prompts.length === 1) {
            return {
              data: {
                info: { structured: { summary: "Plan", steps: ["Change code", "Run test"] } },
                parts: [],
              },
            }
          }
          const text = prompts.length === 2 ? "Reviewed plan" : "Implemented"
          return { data: { info: {}, parts: [{ type: "text", text }] } }
        },
        abort: async () => ({ data: true }),
      },
    } as unknown as OpencodeClient
    const workspaceManager = {
      get: () => ({ id: "workspace", lineageId: "lineage-a", path: "C:/workspace", status: "ready" }),
      list: () => [{ id: "workspace", lineageId: "lineage-a", path: "C:/workspace", status: "ready" }],
    } as unknown as WorkspaceManager
    const events: unknown[] = []
    const eventBus = { publish: (event: unknown) => { events.push(event); return true } } as unknown as EventBus
    const logger = { warn() {}, error() {} } as unknown as Logger
    const manager = new WorkflowManager({
      workspaceManager,
      eventBus,
      logger,
      storageDir,
      createClient: () => client,
    })
    let reloaded: WorkflowManager | undefined

    try {
      const started = await manager.start({
        workspaceId: "workspace",
        objective: "Add workflow support",
        stages: [
          { id: "planner", title: "Planner", instructions: "Create a plan", requiresApproval: true },
          { id: "reviewer", title: "Reviewer", instructions: "Review the approved plan", requiresApproval: true },
          { id: "implementer", title: "Implementer", instructions: "Implement the reviewed plan", requiresApproval: true },
        ],
      })
      let run = started
      for (let attempt = 0; attempt < 50 && run.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        run = (await manager.get(started.id))!
      }

      assert.equal(run.status, "waiting_for_review")
      assert.equal(run.rootSessionId, "session-1")
      assert.deepEqual(run.steps.map((step) => [step.id, step.status, step.sessionId]), [
        ["planner", "completed", "session-2"],
        ["reviewer", "pending", undefined],
        ["implementer", "pending", undefined],
      ])

      run = (await manager.approve(started.id, "planner"))!
      for (let attempt = 0; attempt < 50 && run.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        run = (await manager.get(started.id))!
      }

      assert.equal(run.status, "waiting_for_review")
      assert.deepEqual(run.steps.map((step) => [step.id, step.status, step.sessionId]), [
        ["planner", "completed", "session-2"],
        ["reviewer", "completed", "session-3"],
        ["implementer", "pending", undefined],
      ])

      run = (await manager.approve(started.id, "reviewer"))!
      for (let attempt = 0; attempt < 50 && run.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        run = (await manager.get(started.id))!
      }

      assert.equal(run.status, "waiting_for_review")
      assert.deepEqual(run.steps.map((step) => [step.id, step.status, step.sessionId]), [
        ["planner", "completed", "session-2"],
        ["reviewer", "completed", "session-3"],
        ["implementer", "completed", "session-4"],
      ])
      assert.equal(creates[1]?.parentID, "session-1")
      assert.equal(creates[2]?.parentID, "session-1")
      assert.match(JSON.stringify(prompts[1]), /Change code/)
      assert.match(JSON.stringify(prompts[2]), /Reviewed plan/)
      assert.ok(events.length >= 10)

      await manager.shutdown()
      const restoredWorkspaceManager = {
        get: (id: string) => id === "workspace-restored"
          ? { id, lineageId: "lineage-a", path: "C:/workspace", status: "ready" }
          : undefined,
        list: () => [{ id: "workspace-restored", lineageId: "lineage-a", path: "C:/workspace", status: "ready" }],
      } as unknown as WorkspaceManager
      reloaded = new WorkflowManager({
        workspaceManager: restoredWorkspaceManager,
        eventBus,
        logger,
        storageDir,
        createClient: () => client,
      })
      await assert.rejects(
        reloaded.start({
          workspaceId: "workspace-restored",
          objective: "Conflicting run",
          stages: [{ id: "other", title: "Other", instructions: "Do other work" }],
        }),
        /workspace lineage/,
      )
      run = (await reloaded.approve(started.id, "implementer"))!
      for (let attempt = 0; attempt < 50 && run.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        run = (await reloaded.get(started.id))!
      }
      assert.equal(run.status, "completed")
      const [restored] = await reloaded.list("workspace-restored")
      assert.equal(restored?.workspaceId, "workspace-restored")
    } finally {
      await manager.shutdown()
      await reloaded?.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("fails a stage when its OpenCode request exceeds the operation timeout", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-timeout-"))
    let session = 0
    let aborts = 0
    const client = {
      session: {
        create: async () => ({ data: { id: `session-${++session}` } }),
        prompt: async (_input: unknown, options?: { signal?: AbortSignal }) => new Promise((_, reject) => {
          const signal = options?.signal
          if (!signal) return
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
        abort: async () => ++aborts === 1 ? { error: "abort failed" } : { data: true },
      },
    } as unknown as OpencodeClient
    const workspaceManager = {
      get: () => ({ id: "workspace", lineageId: "lineage-timeout", path: "C:/timeout-workspace", status: "ready" }),
    } as unknown as WorkspaceManager
    const eventBus = { publish: () => true } as unknown as EventBus
    const logger = { warn() {}, error() {} } as unknown as Logger
    const manager = new WorkflowManager({
      workspaceManager,
      eventBus,
      logger,
      storageDir,
      createClient: () => client,
      promptTimeoutMs: 10,
    })

    try {
      const started = await manager.start({
        workspaceId: "workspace",
        objective: "Never finish",
        stages: [{ id: "blocked", title: "Blocked", instructions: "Wait forever" }],
      })
      let run = started
      for (let attempt = 0; attempt < 50 && run.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        run = (await manager.get(started.id))!
      }
      assert.equal(run.status, "recovery_required")
      assert.equal(run.steps[0]?.status, "failed")
      assert.equal(aborts, 1)
      await assert.rejects(manager.start({
        workspaceId: "workspace",
        objective: "Must remain blocked",
        stages: [{ id: "next", title: "Next", instructions: "Do not start" }],
      }), /already running/)
      assert.equal((await manager.cancel(started.id))?.status, "cancelled")
      assert.equal(aborts, 2)
    } finally {
      await manager.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("keeps force-created instances of the same path isolated by lineage", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-lineage-"))
    let session = 0
    const client = {
      session: {
        create: async () => ({ data: { id: `session-${++session}` } }),
        prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "Review me" }] } }),
        abort: async () => ({ data: true }),
      },
    } as unknown as OpencodeClient
    const workspaceManager = {
      get: (id: string) => ({ id, lineageId: id === "a" ? "lineage-a" : "lineage-b", path: "C:/same", status: "ready" }),
    } as unknown as WorkspaceManager
    const eventBus = { publish: () => true } as unknown as EventBus
    const logger = { warn() {}, error() {} } as unknown as Logger
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir, createClient: () => client })

    try {
      const started = await manager.start({
        workspaceId: "a",
        objective: "Lineage A",
        stages: [{ id: "only", title: "Only", instructions: "Run", requiresApproval: true }],
      })
      let run = started
      for (let attempt = 0; attempt < 50 && run.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        run = (await manager.get(started.id))!
      }
      assert.equal(run.status, "waiting_for_review")
      assert.deepEqual(await manager.list("b"), [])
      assert.equal(await manager.get(started.id, "b"), undefined)
    } finally {
      await manager.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("does not fail a completed run when history pruning fails", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-prune-"))
    let session = 0
    const client = {
      session: {
        create: async () => ({ data: { id: `session-${++session}` } }),
        prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "Complete" }] } }),
        abort: async () => ({ data: true }),
      },
    } as unknown as OpencodeClient
    const workspaceManager = {
      get: () => ({ id: "workspace", lineageId: "lineage", path: "C:/workspace", status: "ready" }),
    } as unknown as WorkspaceManager
    let warnings = 0
    const logger = { warn: () => { warnings += 1 }, error() {} } as unknown as Logger
    const manager = new WorkflowManager({
      workspaceManager,
      eventBus: { publish: () => true } as unknown as EventBus,
      logger,
      storageDir,
      createClient: () => client,
    })
    ;(manager as any).pruneHistory = async () => { throw new Error("prune failed") }

    try {
      const started = await manager.start({
        workspaceId: "workspace",
        objective: "Finish despite prune failure",
        stages: [{ id: "only", title: "Only", instructions: "Complete" }],
      })
      let run = started
      for (let attempt = 0; attempt < 50 && run.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        run = (await manager.get(started.id))!
      }

      assert.equal(run.status, "completed")
      assert.equal(warnings, 1)
    } finally {
      await manager.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("clears a rejected cached shutdown so shutdown can be retried", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-shutdown-retry-"))
    const manager = new WorkflowManager({
      workspaceManager: { list: () => [] } as unknown as WorkspaceManager,
      eventBus: { publish: () => true } as unknown as EventBus,
      logger: { warn() {}, error() {} } as unknown as Logger,
      storageDir,
    })
    await manager.list()
    let attempts = 0
    ;(manager as any).performShutdown = async () => {
      if (++attempts === 1) throw new Error("shutdown failed")
    }
    try {
      await assert.rejects(manager.shutdown(), /shutdown failed/)
      await assert.doesNotReject(manager.shutdown())
      assert.equal(attempts, 2)
    } finally {
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })
})
