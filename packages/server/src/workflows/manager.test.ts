import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import type { WorkspaceManager } from "../workspaces/manager"
import { withFilesystemLock } from "./filesystem-lock"
import { WorkflowManager, WorkflowRunError } from "./manager"

describe("WorkflowManager", () => {
  it("keeps a live executor leased when a second manager starts", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-live-owner-"))
    let releasePrompt!: () => void
    let promptStarted!: () => void
    const startedPrompt = new Promise<void>((resolve) => { promptStarted = resolve })
    const blockedPrompt = new Promise<void>((resolve) => { releasePrompt = resolve })
    const client = { tool: { ids: async () => ({ data: [] }) }, session: {
      create: async () => ({ data: { id: "live-session" } }),
      prompt: async () => { promptStarted(); await blockedPrompt; return { data: { info: {}, parts: [] } } },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const workspaceManager = {
      get: () => ({ id: "workspace", lineageId: "live-lineage", path: "C:/live-workspace", status: "ready" }),
      list: () => [{ id: "workspace", lineageId: "live-lineage", path: "C:/live-workspace", status: "ready" }],
    } as unknown as WorkspaceManager
    const options = { workspaceManager, eventBus: { publish: () => true } as unknown as EventBus,
      logger: { warn() {}, error() {} } as unknown as Logger, storageDir, createClient: () => client }
    const owner = new WorkflowManager(options)
    let observer: WorkflowManager | undefined
    try {
      await owner.createDefinition({ version: 1, id: "live", name: "Live", root: {
        type: "agent", id: "work", instructions: "Wait",
      } })
      const started = await owner.start({ workspaceId: "workspace", definitionId: "live" })
      await startedPrompt
      const before = JSON.parse(await fs.readFile(path.join(storageDir, `${started.id}.json`), "utf8"))
      assert.ok(Date.parse(before.executorLease.expiresAt) > Date.now())

      observer = new WorkflowManager(options)
      assert.equal((await observer.get(started.id))?.status, "running")
      const after = JSON.parse(await fs.readFile(path.join(storageDir, `${started.id}.json`), "utf8"))
      assert.equal(after.executorLease.ownerToken, before.executorLease.ownerToken)
      assert.equal(after.executorLease.fence, before.executorLease.fence)
    } finally {
      releasePrompt()
      await owner.shutdown()
      await observer?.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("rejects cross-host control while the executor lease is live", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-remote-cancel-"))
    let releasePrompt!: () => void
    let promptStarted!: () => void
    const startedPrompt = new Promise<void>((resolve) => { promptStarted = resolve })
    const blockedPrompt = new Promise<void>((resolve) => { releasePrompt = resolve })
    let aborts = 0
    const client = { tool: { ids: async () => ({ data: [] }) }, session: {
      create: async () => ({ data: { id: "remote-session" } }),
      prompt: async () => { promptStarted(); await blockedPrompt; return { data: { info: {}, parts: [] } } },
      abort: async () => { aborts++; return { data: true } },
    } } as unknown as OpencodeClient
    const workspaceManager = {
      get: () => ({ id: "workspace", lineageId: "remote-lineage", path: "C:/remote-workspace", status: "ready" }),
      list: () => [{ id: "workspace", lineageId: "remote-lineage", path: "C:/remote-workspace", status: "ready" }],
    } as unknown as WorkspaceManager
    const options = { workspaceManager, eventBus: { publish: () => true } as unknown as EventBus,
      logger: { warn() {}, error() {} } as unknown as Logger, storageDir, createClient: () => client }
    const owner = new WorkflowManager(options)
    const remote = new WorkflowManager(options)
    try {
      await owner.createDefinition({ version: 1, id: "remote", name: "Remote", root: {
        type: "agent", id: "work", instructions: "Wait",
      } })
      const started = await owner.start({ workspaceId: "workspace", definitionId: "remote" })
      await startedPrompt
      await assert.rejects(remote.pause(started.id), (error: WorkflowRunError) => error.statusCode === 409)
      await assert.rejects(remote.cancel(started.id), (error: WorkflowRunError) => error.statusCode === 409)
      await assert.rejects(remote.resume(started.id), (error: WorkflowRunError) => error.statusCode === 409)
      assert.equal(aborts, 0)
      assert.equal((await remote.get(started.id))?.status, "running")

      const journalPath = path.join(storageDir, `${started.id}.json`)
      const expired = JSON.parse(await fs.readFile(journalPath, "utf8"))
      expired.executorLease.heartbeatAt = new Date(Date.now() - 80_000).toISOString()
      expired.executorLease.expiresAt = new Date(Date.now() - 70_000).toISOString()
      await fs.writeFile(journalPath, `${JSON.stringify(expired, null, 2)}\n`, "utf8")
      await assert.rejects(remote.pause(started.id), /not running/)
      assert.equal(JSON.parse(await fs.readFile(journalPath, "utf8")).status, "recovery_required")
      assert.equal((await remote.cancel(started.id))?.status, "cancelled")
      assert.equal(aborts, 1)
      releasePrompt()
      await new Promise((resolve) => setTimeout(resolve, 25))
      assert.equal(JSON.parse(await fs.readFile(journalPath, "utf8")).status, "cancelled")
    } finally {
      releasePrompt()
      await owner.shutdown()
      await remote.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("revalidates the durable executor fence immediately before prompting", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-action-fence-"))
    let prompts = 0
    let sessions = 0
    const client = { tool: { ids: async () => ({ data: [] }) }, session: {
      create: async () => ({ data: { id: `fence-session-${++sessions}` } }),
      prompt: async () => { prompts++; return { data: { info: {}, parts: [] } } },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const workspaceManager = {
      get: () => ({ id: "workspace", lineageId: "fence-lineage", path: "C:/fence-workspace", status: "ready" }),
      list: () => [{ id: "workspace", lineageId: "fence-lineage", path: "C:/fence-workspace", status: "ready" }],
    } as unknown as WorkspaceManager
    const manager = new WorkflowManager({ workspaceManager, eventBus: { publish: () => true } as unknown as EventBus,
      logger: { warn() {}, error() {} } as unknown as Logger, storageDir, createClient: () => client })
    let fenceEntered!: () => void
    let releaseFence!: () => void
    const entered = new Promise<void>((resolve) => { fenceEntered = resolve })
    const blocked = new Promise<void>((resolve) => { releaseFence = resolve })
    const revalidate = (manager as any).revalidateExecutorFence.bind(manager)
    ;(manager as any).revalidateExecutorFence = async (active: unknown) => {
      fenceEntered()
      await blocked
      return revalidate(active)
    }
    try {
      await manager.createDefinition({ version: 1, id: "fenced", name: "Fenced", root: {
        type: "agent", id: "action", instructions: "Must not start",
      } })
      const run = await manager.start({ workspaceId: "workspace", definitionId: "fenced" })
      await entered
      const journalPath = path.join(storageDir, `${run.id}.json`)
      const replaced = JSON.parse(await fs.readFile(journalPath, "utf8"))
      replaced.executorLease = {
        ownerToken: "successor", fence: replaced.executorFence + 1,
        heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      replaced.executorFence += 1
      replaced.revision += 1
      await fs.writeFile(journalPath, `${JSON.stringify(replaced, null, 2)}\n`, "utf8")
      releaseFence()
      for (let attempt = 0; attempt < 100 && !(manager as any).activeRuns.get(run.id)?.leaseLost; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.equal(prompts, 0)
      assert.equal((manager as any).activeRuns.get(run.id)?.leaseLost, true)
    } finally {
      releaseFence?.()
      await manager.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("refreshes ownership created and released by another manager under admission", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-refresh-owner-"))
    let releasePrompt!: () => void
    let promptStarted!: () => void
    const startedPrompt = new Promise<void>((resolve) => { promptStarted = resolve })
    const blockedPrompt = new Promise<void>((resolve) => { releasePrompt = resolve })
    const client = { session: {
      create: async () => ({ data: { id: "ownership-session" } }),
      prompt: async () => { promptStarted(); await blockedPrompt; return { data: { info: {}, parts: [] } } },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const workspaceManager = {
      get: () => ({ id: "workspace", lineageId: "ownership-lineage", path: "C:/ownership-workspace", status: "ready" }),
      list: () => [{ id: "workspace", lineageId: "ownership-lineage", path: "C:/ownership-workspace", status: "ready" }],
    } as unknown as WorkspaceManager
    const options = { workspaceManager, eventBus: { publish: () => true } as unknown as EventBus,
      logger: { warn() {}, error() {} } as unknown as Logger, storageDir, createClient: () => client }
    const observer = new WorkflowManager(options)
    const owner = new WorkflowManager(options)
    try {
      await observer.list()
      const started = await owner.start({ workspaceId: "workspace", objective: "Own", stages: [
        { id: "work", title: "Work", instructions: "Wait" },
      ] })
      await startedPrompt
      assert.equal(await observer.withWorkspaceOwnershipLease(
        { lineageId: "ownership-lineage" }, async (owned) => owned,
      ), true)
      releasePrompt()
      for (let attempt = 0; attempt < 100 && (await owner.get(started.id))?.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.equal(await observer.withWorkspaceOwnershipLease(
        { lineageId: "ownership-lineage" }, async (owned) => owned,
      ), false)
    } finally {
      releasePrompt()
      await owner.shutdown()
      await observer.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("retries initialization after timing out behind a long admission", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-init-retry-"))
    let releaseAdmission!: () => void
    let admissionEntered!: () => void
    const entered = new Promise<void>((resolve) => { admissionEntered = resolve })
    const held = new Promise<void>((resolve) => { releaseAdmission = resolve })
    const admission = withFilesystemLock(path.join(storageDir, ".admission.lock"), async () => {
      admissionEntered()
      await held
    })
    await entered
    const manager = new WorkflowManager({
      workspaceManager: { list: () => [] } as unknown as WorkspaceManager,
      eventBus: { publish: () => true } as unknown as EventBus,
      logger: { warn() {}, error() {} } as unknown as Logger,
      storageDir,
    })
    try {
      await assert.rejects(manager.list(), /Timed out waiting for filesystem lock/)
      releaseAdmission()
      await admission
      await assert.doesNotReject(manager.list())
    } finally {
      releaseAdmission()
      await admission
      await manager.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })
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

  it("retains creation cleanup after three transient failures and retries it on later admission", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-cleanup-"))
    let attempts = 0
    const manager = new WorkflowManager({
      workspaceManager: {
        list: () => [],
        cancelCreationRequest: async () => {
          if (++attempts <= 3) throw new Error("transient cleanup failure")
        },
      } as unknown as WorkspaceManager,
      eventBus: { publish: () => true } as unknown as EventBus,
      logger: { warn() {}, error() {} } as unknown as Logger,
      storageDir,
    })
    try {
      ;(manager as any).deferCreationCleanup("request")
      for (let attempt = 0; attempt < 3; attempt += 1) await (manager as any).drainCreationCleanups()
      assert.equal(attempts, 3)
      assert.equal((manager as any).deferredCreationCleanups.has("request"), true)
      await assert.rejects(manager.startLatest({ workspaceId: "workspace", definitionId: "missing" }), /not found/)
      assert.equal(attempts, 4)
      assert.equal((manager as any).deferredCreationCleanups.size, 0)
    } finally {
      await manager.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("keeps shutdown retryable while deferred creation cleanup remains", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-cleanup-shutdown-"))
    let attempts = 0
    const manager = new WorkflowManager({
      workspaceManager: {
        list: () => [],
        cancelCreationRequest: async () => {
          if (++attempts <= 3) throw new Error("transient cleanup failure")
        },
      } as unknown as WorkspaceManager,
      eventBus: { publish: () => true } as unknown as EventBus,
      logger: { warn() {}, error() {} } as unknown as Logger,
      storageDir,
    })
    try {
      ;(manager as any).deferCreationCleanup("request")
      await assert.rejects(manager.shutdown(), /creation cleanup remains pending/)
      assert.equal((manager as any).deferredCreationCleanups.has("request"), true)
      await manager.shutdown()
      assert.equal(attempts, 4)
      assert.equal((manager as any).deferredCreationCleanups.size, 0)
    } finally {
      await manager.shutdown().catch(() => undefined)
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("cancels a legacy approval that persists while shutdown starts", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-approval-shutdown-"))
    const client = { session: {
      create: async () => ({ data: { id: "legacy-session" } }),
      prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "Review" }] } }),
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const workspaceManager = {
      get: () => ({ id: "workspace", lineageId: "lineage", path: "C:/workspace", status: "ready" }),
      list: () => [{ id: "workspace", lineageId: "lineage", path: "C:/workspace", status: "ready" }],
    } as unknown as WorkspaceManager
    let manager: WorkflowManager
    let armShutdown = false
    let shutdown: Promise<void> | undefined
    const eventBus = { publish: (event: any) => {
      if (armShutdown && event.event?.properties?.status === "running") {
        armShutdown = false
        shutdown = manager.shutdown()
      }
      return true
    } } as unknown as EventBus
    manager = new WorkflowManager({ workspaceManager, eventBus, logger: { warn() {}, error() {} } as unknown as Logger,
      storageDir, createClient: () => client })
    try {
      const started = await manager.start({ workspaceId: "workspace", objective: "Legacy", stages: [
        { id: "review", title: "Review", instructions: "Review", requiresApproval: true },
      ] })
      let waiting = await manager.get(started.id)
      for (let attempt = 0; attempt < 200 && waiting?.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        waiting = await manager.get(started.id)
      }
      assert.equal(waiting?.status, "waiting_for_review")

      armShutdown = true
      const approved = await manager.approve(started.id, "review")
      await shutdown
      assert.equal(approved?.status, "cancelled")
      assert.equal(JSON.parse(await fs.readFile(path.join(storageDir, `${started.id}.json`), "utf8")).status, "cancelled")
    } finally {
      await manager.shutdown()
      await fs.rm(storageDir, { recursive: true, force: true })
    }
  })

  it("quarantines managed-worktree ownership from a malformed active journal", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-workflow-worktree-quarantine-"))
    await fs.writeFile(path.join(storageDir, "malformed.json"), JSON.stringify({
      id: "malformed", status: "running", workspaceId: "execution", workspaceLineageId: "execution-lineage",
      workspacePath: "C:/repo/.codenomad/worktrees/review",
      worktreeSelection: {
        sourceWorkspaceId: "source", sourceWorkspaceLineageId: "source-lineage", sourceWorkspacePath: "C:/repo",
        directory: "C:/repo/.codenomad/worktrees/review", slug: "review",
      },
    }), "utf8")
    const manager = new WorkflowManager({
      workspaceManager: { list: () => [] } as unknown as WorkspaceManager,
      eventBus: { publish: () => true } as unknown as EventBus,
      logger: { warn() {}, error() {} } as unknown as Logger,
      storageDir,
    })
    try {
      assert.equal(await manager.isWorktreeWorkflowOwned(
        { lineageId: "source-lineage" }, { slug: "review" },
      ), true)
      assert.equal(await manager.isWorktreeWorkflowOwned(
        { lineageId: "unrelated" }, { path: "C:/repo/.codenomad/worktrees/review" },
      ), true)
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
