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

      run = (await manager.approve(started.id))!
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

      run = (await manager.approve(started.id))!
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
      run = (await reloaded.approve(started.id))!
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
        abort: async () => { aborts += 1; return { error: "abort failed" } },
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
      assert.equal(run.status, "failed")
      assert.equal(run.steps[0]?.status, "failed")
      assert.equal(aborts, 1)
      await assert.rejects(manager.start({
        workspaceId: "workspace",
        objective: "Must remain blocked",
        stages: [{ id: "next", title: "Next", instructions: "Do not start" }],
      }), /already running/)
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
})
