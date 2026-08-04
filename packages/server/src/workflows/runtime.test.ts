import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, it } from "node:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { WorkflowDefinitionV1, WorkflowRun } from "../api-types"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import type { WorkspaceManager } from "../workspaces/manager"
import { WorkflowInterpreter } from "./interpreter"
import { WorkflowManager } from "./manager"
import { validatePersistedWorkflowRun } from "./run-state"

const workspaceManager = {
  get: (id: string) => ({ id, lineageId: "lineage", path: "C:/workspace", status: "ready" }),
  list: () => [{ id: "workspace", lineageId: "lineage", path: "C:/workspace", status: "ready" }],
} as unknown as WorkspaceManager
const eventBus = { publish: () => true } as unknown as EventBus
const logger = { warn() {}, error() {} } as unknown as Logger
const execFileAsync = promisify(execFile)
const usage = (cost = 0.1, tokens = 10) => ({
  role: "assistant", cost,
  tokens: { total: tokens, input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const workflowTools = { ids: async () => ({ data: ["read", "glob", "grep", "lsp", "bash", "shell", "write", "edit", "apply_patch", "task"] }) }
const waitFor = async (manager: WorkflowManager, id: string, statuses: WorkflowRun["status"][]) => {
  let latest: WorkflowRun | undefined
  for (let attempt = 0; attempt < 600; attempt += 1) {
    latest = (await manager.get(id))!
    if (statuses.includes(latest.status)) return latest
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Workflow ${id} did not reach ${statuses.join(", ")}: ${latest?.status} ${latest?.error ?? ""}`)
}

describe("declarative workflow runtime", () => {
  it("runs branch, foreach, parallel and bounded repeat with structured handoff", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-runtime-"))
    const prompts: Array<Record<string, unknown>> = []
    let sessions = 0
    const client = {
      tool: { ids: async () => ({ data: ["read", "shell", "write"] }) },
      session: {
        create: async () => ({ data: { id: `session-${++sessions}` } }),
        prompt: async (input: Record<string, unknown>) => {
          prompts.push(input)
          const text = JSON.stringify(input.parts)
          return { data: text.includes("Seed")
            ? { info: { ...usage(), structured: { go: true, items: [1, 2, 3] } }, parts: [] }
            : { info: usage(), parts: [{ type: "text", text: "done" }] } }
        },
        shell: async () => ({ data: { info: usage(), parts: [{ type: "tool", state: { status: "completed", output: "shell" } }] } }),
        abort: async () => ({ data: true }),
      },
    } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    const definition: WorkflowDefinitionV1 = {
      version: 1, id: "dynamic", name: "Dynamic", maxConcurrency: 4,
      root: { type: "sequence", id: "root", steps: [
        { type: "agent", id: "seed", title: "Seed", instructions: "Seed", tools: ["read"], outputSchema: {
          type: "object", required: ["go", "items"], properties: { go: { type: "boolean" }, items: { type: "array" } },
        } },
        { type: "condition", id: "branch", condition: { value: { $ref: "nodes.seed.output.go" }, equals: true }, then: {
          type: "foreach", id: "each", items: { $ref: "nodes.seed.output.items" }, item: "item", maxItems: 3, maxConcurrency: 2,
          body: { type: "agent", id: "worker", instructions: "Handle item", context: { $ref: "vars.item" } },
        } },
        { type: "parallel", id: "parallel", maxConcurrency: 2, branches: [
          { type: "agent", id: "left", instructions: "Left" },
          { type: "shell", id: "right", title: "Right", agent: "build", command: "git status --short" },
        ] },
        { type: "repeat", id: "repeat", maxIterations: 2, body: { type: "agent", id: "again", instructions: "Again" } },
      ] },
    }
    try {
      const stored = await manager.createDefinition(definition)
      const started = await manager.start({ workspaceId: "workspace", definitionId: stored.id, objective: "Run graph" })
      const run = await waitFor(manager, started.id, ["completed"])
      assert.equal(run.definitionRevision, 1)
      assert.deepEqual(run.definitionSnapshot, definition)
      assert.equal(run.executionNodes?.filter((node) => node.definitionNodeId === "worker").length, 3)
      assert.equal(run.executionNodes?.filter((node) => node.definitionNodeId === "again").length, 2)
      assert.equal(run.executionNodes?.find((node) => node.definitionNodeId === "right")?.output, "shell")
      assert.match(JSON.stringify(prompts), /Context.*1/)
      assert.deepEqual((prompts[0]?.format as Record<string, unknown>)?.type, "json_schema")
      assert.deepEqual(prompts[0]?.tools, { "*": false, read: true, shell: false, write: false })
      assert.equal(run.usage?.tokens, 80)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("keeps repeat references scoped to their foreach instance", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-repeat-scope-"))
    let sessions = 0
    let seeds = 0
    let releaseSeeds!: () => void
    const bothSeeds = new Promise<void>((resolve) => { releaseSeeds = resolve })
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `repeat-scope-${++sessions}` } }),
      prompt: async (input: Record<string, unknown>) => {
        const prompt = JSON.stringify(input.parts)
        if (prompt.includes("Seed")) {
          if (++seeds === 2) releaseSeeds()
          await bothSeeds
          const item = prompt.includes("Context:\\n1") ? 1 : 0
          return { data: { info: { ...usage(), structured: item }, parts: [] } }
        }
        return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "repeat-scope", name: "Repeat scope", maxConcurrency: 2, root: {
        type: "foreach", id: "each", items: [0, 1], item: "item", maxItems: 2, maxConcurrency: 2, body: {
          type: "sequence", id: "iteration", steps: [
            { type: "agent", id: "seed", title: "Seed", instructions: "Seed", context: { $ref: "vars.item" },
              outputSchema: { type: "number" } },
            { type: "repeat", id: "repeat", maxIterations: 1,
              while: { value: { $ref: "nodes.seed.output" }, equals: { $ref: "vars.item" } },
              body: { type: "agent", id: "work", instructions: "Work" } },
          ],
        },
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "repeat-scope" })
      const run = await waitFor(manager, started.id, ["completed"])
      assert.equal(run.executionNodes?.filter((node) => node.definitionNodeId === "work").length, 2)
    } finally {
      releaseSeeds()
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("does not resolve a skipped foreach producer from a completed sibling", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-skipped-sibling-"))
    let sessions = 0
    const consumerPrompts: string[] = []
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `skipped-sibling-${++sessions}` } }),
      prompt: async (input: Record<string, unknown>) => {
        const prompt = JSON.stringify(input.parts)
        if (prompt.includes("Consume")) consumerPrompts.push(prompt)
        return { data: { info: usage(), parts: [{ type: "text", text: "produced" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "skipped-sibling", name: "Skipped sibling", root: {
        type: "foreach", id: "each", items: [0, 1], item: "item", maxItems: 2, maxConcurrency: 1, body: {
          type: "sequence", id: "iteration", steps: [
            { type: "agent", id: "producer", instructions: "Produce",
              if: { value: { $ref: "vars.item" }, equals: 0 } },
            { type: "agent", id: "consumer", title: "Consume", instructions: "Consume",
              context: { $ref: "nodes.producer.output" } },
          ],
        },
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "skipped-sibling" })
      await waitFor(manager, started.id, ["completed"])
      assert.equal(consumerPrompts.length, 2)
      assert.match(consumerPrompts[0]!, /Context/)
      assert.doesNotMatch(consumerPrompts[1]!, /Context/)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("resolves outer nodes inside foreach without crossing iteration siblings", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-outer-scope-"))
    let sessions = 0
    const consumerPrompts: string[] = []
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `outer-scope-${++sessions}` } }),
      prompt: async (input: Record<string, unknown>) => {
        const prompt = JSON.stringify(input.parts)
        if (prompt.includes("Outer producer")) {
          return { data: { info: { ...usage(), structured: "outer" }, parts: [] } }
        }
        if (prompt.includes("Iteration producer")) {
          const item = prompt.includes("Context:\\n1") ? "one" : "zero"
          return { data: { info: { ...usage(), structured: item }, parts: [] } }
        }
        consumerPrompts.push(prompt)
        return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "outer-scope", name: "Outer scope", root: {
        type: "sequence", id: "root", steps: [
          { type: "sequence", id: "setup", steps: [
            { type: "agent", id: "outer", title: "Outer producer", instructions: "Outer producer", outputSchema: { type: "string" } },
          ] },
          { type: "foreach", id: "each", items: [0, 1], item: "item", maxItems: 2, maxConcurrency: 1, body: {
            type: "sequence", id: "iteration", steps: [
              { type: "agent", id: "local", title: "Iteration producer", instructions: "Iteration producer",
                context: { $ref: "vars.item" }, outputSchema: { type: "string" } },
              { type: "agent", id: "consumer", title: "Consume", instructions: "Consume", context: {
                outer: { $ref: "nodes.outer.output" }, local: { $ref: "nodes.local.output" },
              } },
            ],
          } },
        ],
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "outer-scope" })
      await waitFor(manager, started.id, ["completed"])
      assert.equal(consumerPrompts.length, 2)
      assert.match(consumerPrompts[0]!, /outer.*zero/)
      assert.match(consumerPrompts[1]!, /outer.*one/)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("allows shared context references but rejects ancestor cycles", () => {
    const shared = { value: 1 }
    const run = {
      id: "context", workspaceId: "workspace", workspaceLineageId: "lineage", workspacePath: "C:/workspace",
      objective: "Context", status: "running", steps: [], executionNodes: [], createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as WorkflowRun
    const interpreter = new WorkflowInterpreter({
      run, client: {} as OpencodeClient, persist: async () => {}, signal: () => new AbortController().signal,
      sessionStarted: () => true, sessionFinished: () => {}, abortSession: async () => true, isCancelled: () => false,
    })
    const context = { vars: {}, inputs: { shared }, budgets: [], limiters: [], definitionInvocationKey: "context@1" }
    const resolved = (interpreter as any).resolveContext(
      [{ $ref: "inputs.shared" }, { $ref: "inputs.shared" }], context, new AbortController().signal,
    )
    assert.equal(resolved[0], resolved[1])
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assert.throws(() => (interpreter as any).resolveContext(
      { $ref: "inputs.cyclic" }, { ...context, inputs: { cyclic } }, new AbortController().signal,
    ), /contains a cycle/)
  })

  it("inherits omitted agent tools and applies any explicit installed-tool allowlist", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-tools-"))
    const prompts: Array<Record<string, unknown>> = []
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `tools-${++sessions}` } }),
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "tools-off", name: "Tools off", root: {
        type: "agent", id: "work", instructions: "Read only",
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "tools-off" })
      await waitFor(manager, started.id, ["completed"])
      assert.equal(Object.prototype.hasOwnProperty.call(prompts[0], "tools"), false)

      await manager.createDefinition({ version: 1, id: "tools-dangerous", name: "Dangerous", root: {
        type: "agent", id: "work", instructions: "Run", tools: ["bash", "task"],
      } })
      const dangerous = await manager.start({ workspaceId: "workspace", definitionId: "tools-dangerous" })
      await waitFor(manager, dangerous.id, ["completed"])
      assert.equal((prompts[1]?.tools as Record<string, boolean>).bash, true)
      assert.equal((prompts[1]?.tools as Record<string, boolean>).task, true)
      assert.equal((prompts[1]?.tools as Record<string, boolean>).edit, false)

      await manager.createDefinition({ version: 1, id: "tools-missing", name: "Missing", root: {
        type: "agent", id: "work", instructions: "Run", tools: ["not-installed"],
      } })
      const missing = await manager.start({ workspaceId: "workspace", definitionId: "tools-missing" })
      const failed = await waitFor(manager, missing.id, ["failed"])
      assert.match(failed.error ?? "", /tool not-installed is unavailable/)
      assert.equal(prompts.length, 2)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("persists, reuses, and serializes named agent sessions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-persistent-session-"))
    const promptSessions: string[] = []
    let sessions = 0
    let activePrompts = 0
    let maxActivePrompts = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `persistent-${++sessions}` } }),
      prompt: async (input: { sessionID: string }) => {
        promptSessions.push(input.sessionID)
        maxActivePrompts = Math.max(maxActivePrompts, ++activePrompts)
        await new Promise((resolve) => setTimeout(resolve, 10))
        activePrompts--
        return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "persistent-session", name: "Persistent session", maxConcurrency: 2, root: {
        type: "sequence", id: "root", steps: [
          { type: "repeat", id: "refine", maxIterations: 2,
            body: { type: "agent", id: "worker", sessionKey: "luna-worker", instructions: "Refine" } },
          { type: "parallel", id: "review", maxConcurrency: 2, branches: [
            { type: "agent", id: "left", sessionKey: "luna-worker", instructions: "Review left" },
            { type: "agent", id: "right", sessionKey: "luna-worker", instructions: "Review right" },
          ] },
        ],
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "persistent-session" })
      const run = await waitFor(manager, started.id, ["completed"])
      assert.equal(sessions, 2)
      assert.deepEqual(promptSessions, Array(4).fill("persistent-2"))
      assert.equal(maxActivePrompts, 1)
      assert.deepEqual(run.sessionBindings, { "luna-worker": "persistent-2" })
      const persisted = JSON.parse(await fs.readFile(path.join(directory, `${run.id}.json`), "utf8")) as WorkflowRun
      validatePersistedWorkflowRun(persisted, run.id)
      assert.deepEqual(persisted.sessionBindings, run.sessionBindings)
      assert.throws(() => validatePersistedWorkflowRun({ ...persisted, sessionBindings: { "bad key": "session" } }, run.id),
        /Invalid session bindings/)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("holds a named session until the prior node terminal checkpoint is persisted", async () => {
    const now = new Date().toISOString()
    const definition: WorkflowDefinitionV1 = { version: 1, id: "session-handoff", name: "Session handoff", maxConcurrency: 2,
      root: { type: "parallel", id: "root", maxConcurrency: 2, branches: [
        { type: "agent", id: "left", sessionKey: "worker", instructions: "Left" },
        { type: "agent", id: "right", sessionKey: "worker", instructions: "Right" },
      ] } }
    const run = {
      id: "session-handoff", workspaceId: "workspace", workspaceLineageId: "lineage", workspacePath: "C:/workspace",
      objective: "Handoff", status: "running", steps: [], definitionId: definition.id, definitionRevision: 1,
      definitionSnapshot: definition, inputs: {}, executionNodes: [], createdAt: now, updatedAt: now,
    } as WorkflowRun
    let prompts = 0
    let blockCheckpoint = true
    let checkpointEntered!: () => void
    let releaseCheckpoint!: () => void
    const entered = new Promise<void>((resolve) => { checkpointEntered = resolve })
    const release = new Promise<void>((resolve) => { releaseCheckpoint = resolve })
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: "shared-session" } }),
      prompt: async () => {
        prompts++
        return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const interpreter = new WorkflowInterpreter({
      run, client,
      persist: async () => {
        const completed = run.executionNodes?.filter((node) => node.type === "agent" && node.status === "completed").length ?? 0
        if (blockCheckpoint && completed === 1) {
          blockCheckpoint = false
          checkpointEntered()
          await release
        }
      },
      signal: () => new AbortController().signal, sessionStarted: () => true, sessionFinished: () => {},
      abortSession: async () => true, isCancelled: () => false,
    })

    const execution = interpreter.execute()
    await entered
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(prompts, 1)
    releaseCheckpoint()
    await execution
    assert.equal(prompts, 2)
  })

  it("includes named-session permit waiting in the node timeout", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-session-timeout-"))
    let prompts = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: "timed-session" } }),
      prompt: async (_input: unknown, options?: { signal?: AbortSignal }) => {
        prompts++
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 45)
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(timer)
            reject(options.signal!.reason)
          }, { once: true })
        })
        return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "session-timeout", name: "Session timeout", maxConcurrency: 2,
        root: { type: "parallel", id: "root", maxConcurrency: 2, branches: [
          { type: "agent", id: "left", sessionKey: "worker", instructions: "Left", timeoutMs: 70 },
          { type: "agent", id: "right", sessionKey: "worker", instructions: "Right", timeoutMs: 70 },
        ] } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "session-timeout" })
      await waitFor(manager, started.id, ["failed"])
      assert.ok(prompts >= 1)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("restores a named agent session without creating another session", async () => {
    const now = new Date().toISOString()
    const prompts: string[] = []
    const run = {
      id: "restored-session", workspaceId: "workspace", workspaceLineageId: "lineage", workspacePath: "C:/workspace",
      objective: "Continue", status: "running", rootSessionId: "root", steps: [], definitionId: "restored",
      definitionRevision: 1, definitionSnapshot: { version: 1, id: "restored", name: "Restored", root: {
        type: "agent", id: "continue", sessionKey: "worker", instructions: "Continue",
      } }, sessionBindings: { worker: "existing-session" }, executionNodes: [], createdAt: now, updatedAt: now,
    } as WorkflowRun
    const client = { tool: workflowTools, session: {
      create: async () => { throw new Error("unexpected session creation") },
      prompt: async (input: { sessionID: string }) => {
        prompts.push(input.sessionID)
        return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const checkpoints: WorkflowRun["executionNodes"][] = []
    const interpreter = new WorkflowInterpreter({
      run, client, persist: async () => { checkpoints.push(JSON.parse(JSON.stringify(run.executionNodes))) }, signal: () => new AbortController().signal,
      sessionStarted: () => true, sessionFinished: () => {}, abortSession: async () => true, isCancelled: () => false,
    })

    await interpreter.execute()
    assert.deepEqual(prompts, ["existing-session"])
    assert.equal(checkpoints.some((nodes) => nodes?.some((node) => node.attempt > 0 && !node.sessionIds?.length)), false)
  })

  it("fails only when a repeat configured to fail exhausts its iterations", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-repeat-exhausted-"))
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `repeat-${++sessions}` } }),
      prompt: async () => ({ data: { info: usage(), parts: [{ type: "text", text: "retry" }] } }),
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "repeat-fail", name: "Repeat fail", root: {
        type: "repeat", id: "retry", maxIterations: 1, onExhausted: "fail",
        body: { type: "agent", id: "work", instructions: "Retry" },
      } })
      const exhausted = await manager.start({ workspaceId: "workspace", definitionId: "repeat-fail" })
      const failed = await waitFor(manager, exhausted.id, ["failed"])
      assert.match(failed.error ?? "", /exhausted 1 iterations/)

      await manager.createDefinition({ version: 1, id: "repeat-stop", name: "Repeat stop", root: {
        type: "repeat", id: "retry", maxIterations: 1, while: false, onExhausted: "fail",
        body: { type: "agent", id: "work", instructions: "Do not run" },
      } })
      const stopped = await manager.start({ workspaceId: "workspace", definitionId: "repeat-stop" })
      await waitFor(manager, stopped.id, ["completed"])

      await manager.createDefinition({ version: 1, id: "repeat-satisfied", name: "Repeat satisfied", root: {
        type: "repeat", id: "retry", maxIterations: 1,
        while: { value: { $ref: "nodes.work.output" }, notEquals: "retry" }, onExhausted: "fail",
        body: { type: "agent", id: "work", instructions: "Retry" },
      } })
      const satisfied = await manager.start({ workspaceId: "workspace", definitionId: "repeat-satisfied" })
      await waitFor(manager, satisfied.id, ["completed"])
      assert.equal(sessions, 5)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("pauses at a durable boundary and resumes without repeating completed work", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-pause-"))
    let release!: () => void
    const first = new Promise<void>((resolve) => { release = resolve })
    let prompts = 0
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `session-${++sessions}` } }),
      prompt: async () => { prompts++; if (prompts === 1) await first; return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } } },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "pause", name: "Pause", root: { type: "sequence", id: "root", steps: [
        { type: "agent", id: "one", instructions: "One" }, { type: "agent", id: "two", instructions: "Two" },
      ] } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "pause" })
      while (prompts === 0) await new Promise((resolve) => setTimeout(resolve, 1))
      assert.equal((await manager.pause(started.id))?.status, "pausing")
      release()
      while (started.status !== "paused") await new Promise((resolve) => setTimeout(resolve, 1))
      const resumed = manager.resume(started.id)
      const racedStart = manager.start({ workspaceId: "workspace", definitionId: "pause" })
      await resumed
      await assert.rejects(racedStart, /already running/)
      const run = await waitFor(manager, started.id, ["completed"])
      assert.equal(prompts, 2)
      assert.equal(run.executionNodes?.filter((node) => node.definitionNodeId === "one").length, 1)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("keeps interpreter node references attached when pause persistence fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-pause-rollback-"))
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const secondBlocked = new Promise<void>((resolve) => { releaseSecond = resolve })
    let prompts = 0
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `pause-rollback-${++sessions}` } }),
      prompt: async () => {
        prompts++
        await (prompts === 1 ? firstBlocked : secondBlocked)
        return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "pause-rollback", name: "Pause rollback", root: {
        type: "sequence", id: "root", steps: [
          { type: "agent", id: "one", instructions: "One" },
          { type: "agent", id: "two", instructions: "Two" },
        ],
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "pause-rollback" })
      while (prompts === 0) await new Promise((resolve) => setTimeout(resolve, 1))
      const persist = (manager as any).persist.bind(manager)
      let pauseWriteStarted!: () => void
      const pauseWrite = new Promise<void>((resolve) => { pauseWriteStarted = resolve })
      let rejectPauseWrite!: () => void
      const pauseWriteFailure = new Promise<void>((_, reject) => { rejectPauseWrite = () => reject(new Error("pause write failed")) })
      let failed = false
      ;(manager as any).persist = async (run: WorkflowRun, touch?: boolean) => {
        if (!failed && run.status === "pausing") {
          failed = true
          pauseWriteStarted()
          return pauseWriteFailure
        }
        return persist(run, touch)
      }
      const pausing = manager.pause(started.id)
      await pauseWrite
      releaseFirst()
      while (prompts < 2 || started.usage?.tokens !== 10) await new Promise((resolve) => setTimeout(resolve, 1))
      rejectPauseWrite()
      await assert.rejects(pausing, /pause write failed/)
      assert.equal(started.status, "running")
      assert.equal(started.pauseRequested, undefined)
      assert.equal(started.usage?.tokens, 10)
      assert.deepEqual(started.executionNodes?.filter((node) => node.type === "agent").map((node) => node.status), ["completed", "running"])
      releaseSecond()
      const run = await waitFor(manager, started.id, ["completed"])
      assert.equal(prompts, 2)
      assert.deepEqual(run.executionNodes?.filter((node) => node.type === "agent").map((node) => node.status), ["completed", "completed"])
    } finally {
      releaseFirst()
      releaseSecond()
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("keeps a parallel pause pausing until every worker reaches a boundary", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-parallel-pause-"))
    const releases: Array<() => void> = []
    const blocked = [0, 1].map(() => new Promise<void>((resolve) => releases.push(resolve)))
    let prompts = 0
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `parallel-pause-${++sessions}` } }),
      prompt: async () => {
        const index = prompts++
        if (index < 2) await blocked[index]
        return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "parallel-pause", name: "Parallel pause", maxConcurrency: 2,
        root: { type: "parallel", id: "root", maxConcurrency: 2, branches: [
          { type: "sequence", id: "left", steps: [
            { type: "agent", id: "left-one", instructions: "One" },
            { type: "agent", id: "left-two", instructions: "Two" },
          ] },
          { type: "sequence", id: "right", steps: [
            { type: "agent", id: "right-one", instructions: "One" },
            { type: "agent", id: "right-two", instructions: "Two" },
          ] },
        ] } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "parallel-pause" })
      while (prompts < 2) await new Promise((resolve) => setTimeout(resolve, 1))
      assert.equal((await manager.pause(started.id))?.status, "pausing")
      releases[0]!()
      while (!started.executionNodes?.some((node) => node.definitionNodeId.endsWith("-one") && node.status === "completed")) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      assert.equal(started.status, "pausing")
      assert.equal(prompts, 2)
      releases[1]!()
      await waitFor(manager, started.id, ["paused"])
      assert.equal(prompts, 2)
      await manager.resume(started.id)
      await waitFor(manager, started.id, ["completed"])
      assert.equal(prompts, 4)
    } finally {
      for (const release of releases) release()
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("suspends a limiter waiter before it creates a session", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-pause-waiter-"))
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let prompts = 0
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `pause-waiter-${++sessions}` } }),
      prompt: async () => { prompts++; if (prompts === 1) await blocked; return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } } },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "pause-waiter", name: "Pause waiter", maxConcurrency: 2,
        budget: { maxTokens: 100 }, root: { type: "parallel", id: "root", maxConcurrency: 2, branches: [
          { type: "agent", id: "one", instructions: "One" },
          { type: "agent", id: "two", instructions: "Two" },
        ] } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "pause-waiter" })
      while (prompts === 0) await new Promise((resolve) => setTimeout(resolve, 1))
      await manager.pause(started.id)
      release()
      await waitFor(manager, started.id, ["paused"])
      assert.equal(prompts, 1)
      assert.equal(sessions, 2)
      await manager.resume(started.id)
      await waitFor(manager, started.id, ["completed"])
      assert.equal(prompts, 2)
    } finally {
      release()
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("validates an input gate answer and stops after an observed budget overrun", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-gate-budget-"))
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `session-${++sessions}` } }),
      prompt: async () => ({ data: { info: usage(2, 100), parts: [{ type: "text", text: "costly" }] } }),
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "gate", name: "Gate", budget: { maxCost: 1 }, root: {
        type: "sequence", id: "root", steps: [
          { type: "gate", id: "input", gate: "input", prompt: "Name", inputSchema: {
            type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false,
          } },
          { type: "agent", id: "costly", instructions: "Spend" },
        ],
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "gate" })
      const waiting = await waitFor(manager, started.id, ["waiting_for_input"])
      const gateId = waiting.pendingGate!.executionNodeId
      await assert.rejects(manager.answer(started.id, gateId, {}), /name is required/)
      await manager.answer(started.id, gateId, { name: "Ada" })
      const run = await waitFor(manager, started.id, ["failed"])
      assert.match(run.error ?? "", /cost budget/)
      assert.equal(run.usage?.cost, 2)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("fans cancellation out to every active parallel session", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-cancel-"))
    let sessions = 0
    let prompts = 0
    const aborted = new Set<string>()
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `session-${++sessions}` } }),
      prompt: async (_input: unknown, options?: { signal?: AbortSignal }) => {
        prompts++
        return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }))
      },
      abort: async ({ sessionID }: { sessionID: string }) => { aborted.add(sessionID); return { data: true } },
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "cancel", name: "Cancel", maxConcurrency: 2, root: {
        type: "parallel", id: "root", maxConcurrency: 2, branches: [
          { type: "agent", id: "one", instructions: "Wait" }, { type: "agent", id: "two", instructions: "Wait" },
        ],
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "cancel" })
      while (prompts < 2) await new Promise((resolve) => setTimeout(resolve, 1))
      await manager.cancel(started.id)
      const run = await waitFor(manager, started.id, ["cancelled"])
      assert.equal(aborted.size, 2)
      assert.equal(run.executionNodes?.filter((node) => node.status === "cancelled").length, 3)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("aborts a child session created after cancellation begins", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-create-cancel-"))
    let sessions = 0
    let releaseCreate!: () => void
    const childCreate = new Promise<void>((resolve) => { releaseCreate = resolve })
    const aborted: string[] = []
    let prompts = 0
    const client = { tool: workflowTools, session: {
      create: async () => {
        const id = `late-${++sessions}`
        if (sessions === 2) await childCreate
        return { data: { id } }
      },
      prompt: async () => { prompts++; return { data: { info: usage(), parts: [] } } },
      abort: async ({ sessionID }: { sessionID: string }) => { aborted.push(sessionID); return { data: true } },
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "create-cancel", name: "Create cancel", root: {
        type: "agent", id: "work", instructions: "Wait",
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "create-cancel" })
      while (sessions < 2) await new Promise((resolve) => setTimeout(resolve, 1))
      const cancellation = manager.cancel(started.id)
      releaseCreate()
      assert.equal((await cancellation)?.status, "cancelled")
      assert.deepEqual(aborted, ["late-2"])
      assert.equal(prompts, 0)
    } finally {
      releaseCreate()
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("does not retry an unconfirmed side effect and retains recovery reservation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-ambiguous-"))
    let prompts = 0
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `ambiguous-${++sessions}` } }),
      prompt: async () => { prompts++; throw new Error("connection lost") },
      abort: async () => ({ data: false }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "ambiguous", name: "Ambiguous", root: {
        type: "agent", id: "work", instructions: "Act", retry: { maxAttempts: 2, idempotent: true },
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "ambiguous" })
      const run = await waitFor(manager, started.id, ["recovery_required"])
      assert.equal(prompts, 1)
      assert.equal(run.executionNodes?.find((node) => node.definitionNodeId === "work")?.status, "interrupted")
      await assert.rejects(manager.start({ workspaceId: "workspace", definitionId: "ambiguous" }), /already running/)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("resumes a confirmed-abort checkpoint captured during retry delay", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-retry-checkpoint-"))
    const now = new Date().toISOString()
    const definition: WorkflowDefinitionV1 = { version: 1, id: "retry-checkpoint", name: "Retry checkpoint", root: {
      type: "agent", id: "work", instructions: "Retry", retry: { maxAttempts: 2, delayMs: 60_000, idempotent: true },
    } }
    const run = {
      id: "00000000-0000-4000-8000-000000000090", workspaceId: "workspace", workspaceLineageId: "lineage",
      workspacePath: "C:/workspace", objective: "Retry safely", status: "running", rootSessionId: "root", steps: [], revision: 1,
      definitionId: definition.id, definitionRevision: 1, definitionSnapshot: definition, inputs: {}, executionNodes: [],
      createdAt: now, updatedAt: now,
    } as WorkflowRun
    let prompts = 0
    let sessions = 0
    let checkpoint: WorkflowRun | undefined
    const crash = new AbortController()
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `retry-checkpoint-${++sessions}` } }),
      prompt: async () => {
        if (++prompts === 1) throw new Error("retryable failure")
        return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const interpreter = new WorkflowInterpreter({
      run, client,
      persist: async () => {
        const action = run.executionNodes?.find((node) => node.definitionNodeId === "work")
        if (!checkpoint && action?.status === "waiting" && action.attempt === 1 && !action.sessionIds?.length) {
          checkpoint = JSON.parse(JSON.stringify(run)) as WorkflowRun
          crash.abort(new Error("simulated crash"))
        }
      },
      signal: () => crash.signal, sessionStarted: () => true, sessionFinished: () => {},
      abortSession: async () => true, isCancelled: () => false,
    })
    let manager: WorkflowManager | undefined
    try {
      await assert.rejects(interpreter.execute(), /simulated crash/)
      assert.equal(checkpoint?.executionNodes?.[0]?.attempt, 1)
      assert.equal(checkpoint?.executionNodes?.[0]?.status, "waiting")
      assert.equal(checkpoint?.executionNodes?.[0]?.sessionIds, undefined)
      await fs.writeFile(path.join(directory, `${run.id}.json`), JSON.stringify(checkpoint), "utf8")
      manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
      const recovered = (await manager.get(run.id))!
      assert.equal(recovered.status, "interrupted")
      assert.equal(recovered.executionNodes?.[0]?.attempt, 1)
      await manager.resume(run.id)
      const completed = await waitFor(manager, run.id, ["completed"])
      assert.equal(completed.executionNodes?.[0]?.attempt, 2)
      assert.equal(prompts, 2)
    } finally {
      await manager?.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("serializes budgeted actions and enforces usage before admitting another action", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-budget-admission-"))
    let prompts = 0
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `budget-${++sessions}` } }),
      prompt: async () => { prompts++; return { data: { info: usage(0.1, 11), parts: [{ type: "text", text: "spent" }] } } },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "budget-admission", name: "Budget", maxConcurrency: 3,
        budget: { maxTokens: 10 }, root: { type: "parallel", id: "root", maxConcurrency: 3, branches: [
          { type: "agent", id: "one", instructions: "One" },
          { type: "agent", id: "two", instructions: "Two" },
          { type: "agent", id: "three", instructions: "Three" },
        ] } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "budget-admission" })
      const run = await waitFor(manager, started.id, ["failed"])
      assert.match(run.error ?? "", /token budget 10/)
      assert.equal(prompts, 1)
      assert.equal(run.usage?.tokens, 11)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("uses one action deadline across tool lookup, session creation and retries", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-deadline-"))
    const signals: AbortSignal[] = []
    let sessions = 0
    let prompts = 0
    const client = {
      tool: { ids: async (_input: unknown, options?: { signal?: AbortSignal }) => {
        signals.push(options!.signal!); return { data: ["read"] }
      } },
      session: {
        create: async (_input: unknown, options?: { signal?: AbortSignal }) => {
          sessions++
          if (sessions > 1) signals.push(options!.signal!)
          return { data: { id: `deadline-${sessions}` } }
        },
        prompt: async (_input: unknown, options?: { signal?: AbortSignal }) => {
          prompts++
          signals.push(options!.signal!)
          return new Promise((_, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }))
        },
        abort: async () => ({ data: true }),
      },
    } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "deadline", name: "Deadline", root: {
        type: "agent", id: "work", instructions: "Wait", timeoutMs: 500, retry: { maxAttempts: 2, idempotent: true },
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "deadline" })
      const failed = await waitFor(manager, started.id, ["failed"])
      assert.equal(prompts, 1)
      assert.equal(sessions, 2)
      assert.ok(signals.every((signal) => signal === signals[0]))
      assert.equal(failed.executionNodes?.find((node) => node.definitionNodeId === "work")?.attempt, 1)
      assert.equal(failed.executionNodes?.find((node) => node.definitionNodeId === "work")?.sessionIds, undefined)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("requires explicit recovery before an ambiguous persisted side effect can repeat", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-recovery-"))
    const id = "00000000-0000-4000-8000-000000000099"
    const now = new Date().toISOString()
    const definition: WorkflowDefinitionV1 = {
      version: 1, id: "recover", name: "Recover",
      root: { type: "agent", id: "work", sessionKey: "worker", instructions: "Potential side effect" },
    }
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      id, workspaceId: "workspace", workspaceLineageId: "lineage", workspacePath: "C:/workspace",
      objective: "Recover", status: "running", rootSessionId: "root", steps: [], revision: 2,
      definitionId: "recover", definitionRevision: 1, definitionSnapshot: definition, inputs: {},
      usage: { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      executionNodes: [{
        id: "execution", instanceKey: "work", definitionNodeId: "work", type: "agent", status: "running",
        attempt: 1, sessionIds: ["ambiguous"], startedAt: now,
      }],
      sessionBindings: { worker: "ambiguous" },
      createdAt: now, updatedAt: now,
    }), "utf8")
    let sessions = 0
    const calls: string[] = []
    const client = { tool: workflowTools, session: {
      create: async () => { const id = `recovery-${++sessions}`; calls.push(`create:${id}`); return { data: { id } } },
      prompt: async () => { calls.push("prompt"); return { data: { info: usage(), parts: [{ type: "text", text: "confirmed" }] } } },
      abort: async ({ sessionID }: { sessionID: string }) => { calls.push(`abort:${sessionID}`); return { data: true } },
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      const recovered = (await manager.get(id))!
      assert.equal(recovered.status, "recovery_required")
      assert.equal(recovered.executionNodes?.[0]?.status, "interrupted")
      await assert.rejects(manager.resume(id), /Recovery confirmation is required/)
      const recoveryRevision = recovered.revision!
      await assert.rejects(manager.resume(id, true, recoveryRevision - 1), /confirmation is stale/)
      await manager.resume(id, true, recoveryRevision)
      const completed = await waitFor(manager, id, ["completed"])
      assert.equal(completed.executionNodes?.[0]?.output, "confirmed")
      assert.deepEqual(calls.slice(0, 3), ["abort:ambiguous", "create:recovery-1", "prompt"])
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("keeps recovery required when persisted session abort is unconfirmed", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-recovery-failed-"))
    const id = "00000000-0000-4000-8000-000000000098"
    const now = new Date().toISOString()
    const definition: WorkflowDefinitionV1 = {
      version: 1, id: "recover-failed", name: "Recover failed",
      root: { type: "agent", id: "work", instructions: "Potential side effect" },
    }
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      id, workspaceId: "workspace", workspaceLineageId: "lineage", workspacePath: "C:/workspace",
      objective: "Recover", status: "recovery_required", rootSessionId: "root", steps: [], revision: 2,
      definitionId: definition.id, definitionRevision: 1, definitionSnapshot: definition, inputs: {},
      usage: { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      executionNodes: [{ id: "execution", instanceKey: "work", definitionNodeId: "work", type: "agent",
        status: "interrupted", attempt: 1, sessionIds: ["ambiguous"], startedAt: now, completedAt: now }],
      createdAt: now, updatedAt: now,
    }), "utf8")
    let creates = 0
    const client = { tool: workflowTools, session: {
      create: async () => { creates++; return { data: { id: "unexpected" } } },
      abort: async () => ({ data: false }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition(definition)
      const recovered = (await manager.get(id))!
      await assert.rejects(manager.resume(id, true, recovered.revision), /could not confirm/)
      const run = (await manager.get(id))!
      assert.equal(run.status, "recovery_required")
      assert.equal(run.executionNodes?.[0]?.status, "interrupted")
      assert.equal(creates, 0)
      await assert.rejects(manager.start({ workspaceId: "workspace", definitionId: definition.id }), /already running/)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("recovers session-bearing paused nodes independent of node type before answering or cancelling", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-paused-session-"))
    const id = "00000000-0000-4000-8000-000000000095"
    const now = new Date().toISOString()
    const definition: WorkflowDefinitionV1 = { version: 1, id: "paused-session", name: "Paused", root: {
      type: "gate", id: "gate", gate: "approval", prompt: "Approve",
    } }
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      id, workspaceId: "workspace", workspaceLineageId: "lineage", workspacePath: "C:/workspace",
      objective: "Paused", status: "paused", steps: [], revision: 1,
      definitionId: definition.id, definitionRevision: 1, definitionSnapshot: definition, inputs: {},
      usage: { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      executionNodes: [{ id: "execution", instanceKey: "gate", definitionNodeId: "gate", type: "gate",
        status: "waiting", attempt: 0, sessionIds: ["unexpected-session"], startedAt: now }],
      pendingGate: { executionNodeId: "execution", definitionNodeId: "gate", gate: "approval", prompt: "Approve" },
      createdAt: now, updatedAt: now,
    }), "utf8")
    let confirmAbort = false
    const aborted: string[] = []
    const client = { session: {
      abort: async ({ sessionID }: { sessionID: string }) => { aborted.push(sessionID); return { data: confirmAbort } },
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      const recovered = (await manager.get(id))!
      assert.equal(recovered.status, "recovery_required")
      assert.equal(recovered.executionNodes?.[0]?.status, "interrupted")
      await assert.rejects(manager.answer(id, "execution", true), /not waiting for a gate answer/)
      assert.equal((await manager.cancel(id))?.status, "recovery_required")
      confirmAbort = true
      assert.equal((await manager.cancel(id))?.status, "cancelled")
      assert.deepEqual(aborted, ["unexpected-session", "unexpected-session"])
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("serializes lineage admission and rejects a stale answer after the next gate opens", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-admission-"))
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `gate-${++sessions}` } }),
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "gates", name: "Gates", root: {
        type: "sequence", id: "root", steps: [
          { type: "gate", id: "first", gate: "approval", prompt: "First" },
          { type: "gate", id: "second", gate: "approval", prompt: "Second" },
        ],
      } })
      const starts = await Promise.allSettled([
        manager.start({ workspaceId: "workspace", definitionId: "gates" }),
        manager.start({ workspaceId: "workspace", definitionId: "gates" }),
      ])
      assert.equal(starts.filter((result) => result.status === "fulfilled").length, 1)
      assert.match((starts.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message, /already running/)
      const started = (starts.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<WorkflowRun>).value
      const first = await waitFor(manager, started.id, ["waiting_for_review"])
      const firstGate = first.pendingGate!.executionNodeId
      const answers = await Promise.allSettled([
        manager.answer(started.id, firstGate, true),
        manager.answer(started.id, firstGate, true),
      ])
      assert.equal(answers.filter((result) => result.status === "fulfilled").length, 1)
      assert.match((answers.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message, /stale/)
      const second = await waitFor(manager, started.id, ["waiting_for_review"])
      assert.equal(second.pendingGate?.definitionNodeId, "second")
      await manager.approve(started.id, second.pendingGate!.executionNodeId)
      await waitFor(manager, started.id, ["completed"])
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("pins and executes nested saved definitions with shared inputs, concurrency and budgets", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-nested-"))
    let sessions = 0
    let prompts = 0
    let active = 0
    let maxActive = 0
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const seenPrompts: string[] = []
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `nested-${++sessions}` } }),
      prompt: async (input: Record<string, unknown>) => {
        prompts++
        active++
        maxActive = Math.max(maxActive, active)
        seenPrompts.push(JSON.stringify(input.parts))
        if (prompts === 1) await blocked
        active--
        return { data: { info: usage(0.1, 10), parts: [{ type: "text", text: "nested-output" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({
        version: 1, id: "child", name: "Child", budget: { maxTokens: 25 }, maxConcurrency: 1,
        root: { type: "parallel", id: "child-root", branches: [
          { type: "agent", id: "child-work-1", instructions: "Old child instructions", context: { $ref: "inputs.message" } },
          { type: "agent", id: "child-work-2", instructions: "Old child instructions", context: { $ref: "inputs.message" } },
        ] },
      })
      await manager.createDefinition({
        version: 1, id: "parent", name: "Parent", maxConcurrency: 2, budget: { maxTokens: 15 },
        root: { type: "workflow", id: "nested", definitionId: "child", inputs: { message: { $ref: "inputs.message" } } },
      })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "parent", inputs: { message: "hello" } })
      while (prompts === 0) await new Promise((resolve) => setTimeout(resolve, 1))
      await manager.updateDefinition("child", 1, {
        version: 1, id: "child", name: "Child",
        root: { type: "agent", id: "child-work", instructions: "New child instructions" },
      })
      release()
      const run = await waitFor(manager, started.id, ["failed"])
      assert.equal(run.savedDefinitionSnapshots?.length, 1)
      assert.equal(run.savedDefinitionSnapshots?.[0]?.revision, 1)
      assert.equal((run.definitionSnapshot?.root as { definitionRevision?: number }).definitionRevision, 1)
      assert.equal(run.executionNodes?.filter((node) => node.definitionNodeId.startsWith("child-work-")).length, 2)
      assert.equal(run.usage?.tokens, 20)
      assert.match(run.error ?? "", /cost budget|token budget 15/)
      assert.equal(maxActive, 1)
      assert.match(seenPrompts.join("\n"), /Old child instructions/)
      assert.match(seenPrompts.join("\n"), /hello/)
      assert.doesNotMatch(seenPrompts.join("\n"), /New child instructions/)
    } finally {
      release()
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("shares a saved-definition budget admission lock across parallel invocations", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-shared-nested-budget-"))
    let sessions = 0
    let prompts = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `shared-budget-${++sessions}` } }),
      prompt: async () => { prompts++; return { data: { info: usage(0, 11), parts: [{ type: "text", text: "spent" }] } } },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "shared-budget-child", name: "Child", budget: { maxTokens: 10 }, root: {
        type: "agent", id: "spend", instructions: "Spend",
      } })
      await manager.createDefinition({ version: 1, id: "shared-budget-parent", name: "Parent", maxConcurrency: 2, root: {
        type: "parallel", id: "root", maxConcurrency: 2, branches: [
          { type: "workflow", id: "first", definitionId: "shared-budget-child" },
          { type: "workflow", id: "second", definitionId: "shared-budget-child" },
        ],
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "shared-budget-parent" })
      assert.match((await waitFor(manager, started.id, ["failed"])).error ?? "", /token budget 10/)
      assert.equal(prompts, 1)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("keeps nodes references inside one saved-definition invocation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-reference-scope-"))
    let sessions = 0
    const prompts: string[] = []
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `scope-${++sessions}` } }),
      prompt: async (input: Record<string, unknown>) => {
        const prompt = JSON.stringify(input.parts)
        prompts.push(prompt)
        const text = prompt.includes("Parent seed") ? "parent-value" : prompt.includes("Child seed") ? "child-value" : "done"
        return { data: { info: usage(), parts: [{ type: "text", text }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "scope-child", name: "Child", root: {
        type: "sequence", id: "child-root", steps: [
          { type: "agent", id: "seed", instructions: "Child seed" },
          { type: "agent", id: "consume", instructions: "Child consume", context: { $ref: "nodes.seed.output" } },
        ],
      } })
      await manager.createDefinition({ version: 1, id: "scope-parent", name: "Parent", root: {
        type: "sequence", id: "parent-root", steps: [
          { type: "agent", id: "seed", instructions: "Parent seed" },
          { type: "workflow", id: "child", definitionId: "scope-child" },
        ],
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "scope-parent" })
      await waitFor(manager, started.id, ["completed"])
      const consume = prompts.find((prompt) => prompt.includes("Child consume")) ?? ""
      assert.match(consume, /child-value/)
      assert.doesNotMatch(consume, /parent-value/)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("defaults each nested workflow invocation to one concurrent action", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-nested-default-"))
    let sessions = 0
    let active = 0
    let maxActive = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `nested-default-${++sessions}` } }),
      prompt: async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "nested-child", name: "Child", root: {
        type: "parallel", id: "child-root", maxConcurrency: 2, branches: [
          { type: "agent", id: "one", instructions: "One" }, { type: "agent", id: "two", instructions: "Two" },
        ],
      } })
      await manager.createDefinition({ version: 1, id: "nested-parent", name: "Parent", maxConcurrency: 2, root: {
        type: "workflow", id: "child", definitionId: "nested-child",
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "nested-parent" })
      await waitFor(manager, started.id, ["completed"])
      assert.equal(maxActive, 1)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("cancels nested limiter waiters without deadlocking an invalid transition or shutdown", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-limiter-cancel-"))
    let sessions = 0
    let prompts = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `limiter-${++sessions}` } }),
      prompt: async (_input: unknown, options?: { signal?: AbortSignal }) => {
        prompts++
        return new Promise((_, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }))
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "limiter-child", name: "Child", root: {
        type: "parallel", id: "child-root", maxConcurrency: 2, branches: [
          { type: "agent", id: "one", instructions: "One" }, { type: "agent", id: "two", instructions: "Two" },
        ],
      } })
      await manager.createDefinition({ version: 1, id: "limiter-parent", name: "Parent", maxConcurrency: 2, root: {
        type: "workflow", id: "child", definitionId: "limiter-child",
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "limiter-parent" })
      while (prompts === 0) await new Promise((resolve) => setTimeout(resolve, 1))
      await assert.rejects(Promise.race([
        manager.resume(started.id),
        new Promise((_, reject) => setTimeout(() => reject(new Error("resume deadlocked")), 100)),
      ]), /cannot be resumed/)
      await manager.shutdown()
      assert.equal(prompts, 1)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("serializes current-workspace rebinding against authoritative persisted state", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-bind-"))
    const id = "00000000-0000-4000-8000-000000000097"
    const now = new Date().toISOString()
    const definition: WorkflowDefinitionV1 = { version: 1, id: "bound", name: "Bound", root: {
      type: "agent", id: "work", instructions: "Done",
    } }
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      id, workspaceId: "old", workspaceLineageId: "lineage", workspacePath: "C:/workspace",
      objective: "Bound", status: "interrupted", rootSessionId: "root", steps: [], revision: 1,
      definitionId: definition.id, definitionRevision: 1, definitionSnapshot: definition, inputs: {},
      worktreeSelection: { policy: { mode: "current" }, sourceWorkspaceId: "old", sourceWorkspaceLineageId: "lineage",
        sourceWorkspacePath: "C:/workspace", workspaceId: "old", directory: "C:/workspace", created: false },
      usage: { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      executionNodes: [{ id: "execution", instanceKey: "work", definitionNodeId: "work", type: "agent",
        status: "completed", attempt: 1, output: "done", startedAt: now, completedAt: now }],
      createdAt: now, updatedAt: now,
    }), "utf8")
    const restoredWorkspaces = {
      get: (workspaceId: string) => workspaceId === "restored"
        ? { id: "restored", lineageId: "lineage", path: "C:/workspace", status: "ready" }
        : undefined,
      list: () => [{ id: "restored", lineageId: "lineage", path: "C:/workspace", status: "ready" }],
    } as unknown as WorkspaceManager
    const manager = new WorkflowManager({ workspaceManager: restoredWorkspaces, eventBus, logger, storageDir: directory })
    try {
      const persist = (manager as any).persist.bind(manager)
      ;(manager as any).persist = async (run: WorkflowRun, touch?: boolean) => {
        if (run.workspaceId === "restored") throw new Error("bind write failed")
        return persist(run, touch)
      }
      await assert.rejects(manager.get(id, "restored"), /bind write failed/)
      assert.equal((await manager.get(id))?.workspaceId, "old")
      assert.equal((manager as any).activeWorkspaces.get("old"), id)
      assert.equal((manager as any).activeWorkspaces.has("restored"), false)
      ;(manager as any).persist = persist
      const [run, listed] = await Promise.all([manager.get(id, "restored"), manager.list("restored")])
      assert.equal(run?.workspaceId, "restored")
      assert.equal(run?.worktreeSelection?.workspaceId, "restored")
      assert.equal(run?.worktreeSelection?.sourceWorkspaceId, "restored")
      assert.equal(listed[0]?.workspaceId, "restored")
      const stored = JSON.parse(await fs.readFile(path.join(directory, `${id}.json`), "utf8")) as WorkflowRun
      assert.equal(stored.worktreeSelection?.sourceWorkspaceId, "restored")
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("skips corrupt history and never prunes interrupted runs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-history-"))
    const now = new Date().toISOString()
    for (let index = 0; index < 101; index++) await fs.writeFile(path.join(directory, `complete-${index}.json`), JSON.stringify({
      id: `complete-${index}`, workspaceId: `history-${index % 2}`, workspaceLineageId: `history-lineage-${index % 2}`,
      workspacePath: `C:/history-${index % 2}`,
      objective: "History", status: "completed", steps: [], createdAt: now, updatedAt: new Date(Date.now() + index).toISOString(),
    }), "utf8")
    await fs.writeFile(path.join(directory, "interrupted.json"), JSON.stringify({
      id: "interrupted", workspaceId: "interrupted-workspace", workspaceLineageId: "interrupted-lineage", workspacePath: "C:/interrupted",
      objective: "Resume me", status: "interrupted", steps: [], createdAt: "9999-01-01T00:00:00.000Z", updatedAt: now,
    }), "utf8")
    await fs.writeFile(path.join(directory, "corrupt.json"), JSON.stringify({ id: "corrupt", status: "completed" }), "utf8")
    let sessions = 0
    const client = { session: {
      create: async () => ({ data: { id: `history-${++sessions}` } }),
      prompt: async () => ({ data: { info: usage(), parts: [{ type: "text", text: "done" }] } }),
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      assert.equal((await manager.list()).some((run) => run.id === "interrupted"), true)
      const started = await manager.start({ workspaceId: "workspace", objective: "Prune", stages: [{ id: "stage", title: "Stage", instructions: "Run" }] })
      await waitFor(manager, started.id, ["completed"])
      const entries = await fs.readdir(directory)
      assert.equal(entries.includes("interrupted.json"), true)
      assert.equal(entries.includes("corrupt.json"), true)
      assert.equal(entries.filter((entry) => entry.endsWith(".json") && entry !== "interrupted.json" && entry !== "corrupt.json").length, 100)
      await assert.doesNotReject(manager.list())
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("rejects saved workflow cycles and excessive nesting before creating sessions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-nesting-"))
    let sessions = 0
    const client = { tool: workflowTools, session: { create: async () => { sessions++; return { data: { id: "unexpected" } } } } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "cycle-a", name: "A", root: { type: "workflow", id: "call-b", definitionId: "cycle-b" } })
      await manager.createDefinition({ version: 1, id: "cycle-b", name: "B", root: { type: "workflow", id: "call-a", definitionId: "cycle-a" } })
      await assert.rejects(manager.start({ workspaceId: "workspace", definitionId: "cycle-a" }), /cycle-a -> cycle-b -> cycle-a/)

      for (let index = 9; index >= 0; index -= 1) await manager.createDefinition({
        version: 1, id: `depth-${index}`, name: `Depth ${index}`,
        root: index === 9
          ? { type: "condition", id: "leaf", condition: false, then: { type: "agent", id: "never", instructions: "Never" } }
          : { type: "workflow", id: `call-${index + 1}`, definitionId: `depth-${index + 1}` },
      })
      await assert.rejects(manager.start({ workspaceId: "workspace", definitionId: "depth-0" }), /maximum depth 8/)
      assert.equal(sessions, 0)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("launches new and existing managed worktrees as retained OpenCode workspaces", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-worktree-run-"))
    const repo = path.join(directory, "repo")
    await fs.mkdir(repo)
    await execFileAsync("git", ["init"], { cwd: repo })
    await fs.writeFile(path.join(repo, "README.md"), "initial\n")
    await execFileAsync("git", ["add", "README.md"], { cwd: repo })
    await execFileAsync("git", ["-c", "user.name=CodeNomad", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: repo })

    const descriptors = new Map<string, any>([["source", {
      id: "source", lineageId: "source-lineage", path: repo, status: "ready", binaryId: "opencode",
    }]])
    const launchedDirectories: string[] = []
    const cancelledCreationRequests: string[] = []
    let workspaceNumber = 0
    let retainCreation = true
    let manager!: WorkflowManager
    const managedWorkspaces = {
      get: (id: string) => descriptors.get(id),
      list: () => Array.from(descriptors.values()),
      create: async (folder: string) => {
        launchedDirectories.push(folder)
        const existing = Array.from(descriptors.values()).find((entry) => path.resolve(entry.path) === path.resolve(folder))
        if (existing) return { workspace: existing, created: false }
        const id = `target-${++workspaceNumber}`
        const workspace = { id, lineageId: `${id}-lineage`, path: folder, status: "ready", binaryId: "opencode" }
        descriptors.set(id, workspace)
        return { workspace, created: true }
      },
      releaseCreationRequest: () => retainCreation,
      cancelCreationRequest: async (requestId: string) => {
        cancelledCreationRequests.push(requestId)
        assert.equal(await manager.withWorkspaceOwnershipLease({ id: `target-${workspaceNumber}` }, async (owned) => owned), false)
      },
    } as unknown as WorkspaceManager
    const clientWorkspaceIds: string[] = []
    const publishedWorkspaceIds: string[] = []
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `worktree-${++sessions}` } }),
      prompt: async () => ({ data: { info: usage(), parts: [{ type: "text", text: "done" }] } }),
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    manager = new WorkflowManager({
      workspaceManager: managedWorkspaces,
      eventBus: { publish: (event: { instanceId: string }) => { publishedWorkspaceIds.push(event.instanceId); return true } } as unknown as EventBus,
      logger,
      storageDir: path.join(directory, "runs"), definitionsDir: path.join(directory, "definitions"),
      createClient: (workspaceId) => { clientWorkspaceIds.push(workspaceId); return client },
    })
    const prunedLineages: string[] = []
    const pruneHistory = (manager as any).pruneHistory.bind(manager)
    ;(manager as any).pruneHistory = async (lineageId: string) => {
      prunedLineages.push(lineageId)
      return pruneHistory(lineageId)
    }
    try {
      await manager.createDefinition({ version: 1, id: "isolated", name: "Isolated", root: { type: "agent", id: "work", instructions: "Work" } })
      await assert.rejects(manager.start({
        workspaceId: "source", definitionId: "isolated", initiatorSessionId: "source-session",
        worktree: { mode: "new", slug: "workflow-test" },
      }), /initiatorSessionId is unsupported/)
      const created = await manager.start({ workspaceId: "source", definitionId: "isolated", worktree: { mode: "new", slug: "workflow-test" } })
      const first = await waitFor(manager, created.id, ["completed"])
      assert.equal(first.worktreeSelection?.created, true)
      assert.equal(first.worktreeSelection?.slug, "workflow-test")
      assert.equal(first.workspacePath, launchedDirectories[0])
      assert.equal(first.workspaceId, clientWorkspaceIds[0])
      assert.ok(publishedWorkspaceIds.includes("source"))
      assert.ok(publishedWorkspaceIds.includes(first.workspaceId))
      await fs.writeFile(path.join(first.workspacePath, "dirty.txt"), "retain me\n")

      const reused = await manager.start({ workspaceId: "source", definitionId: "isolated", worktree: { mode: "existing", slug: "workflow-test" } })
      const second = await waitFor(manager, reused.id, ["completed"])
      assert.equal(second.worktreeSelection?.created, false)
      assert.equal(second.workspacePath, first.workspacePath)
      assert.deepEqual(prunedLineages, ["source-lineage", "source-lineage"])
      assert.equal(await fs.readFile(path.join(first.workspacePath, "dirty.txt"), "utf8"), "retain me\n")
      retainCreation = false
      await assert.rejects(manager.start({ workspaceId: "source", definitionId: "isolated", worktree: {
        mode: "existing", slug: "workflow-test",
      } }), /ownership could not be retained/)
      assert.equal(cancelledCreationRequests.length, 1)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("resumes an action that crashed before admission without recovery confirmation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-pre-admission-recovery-"))
    const id = "00000000-0000-4000-8000-000000000093"
    const now = new Date().toISOString()
    const definition: WorkflowDefinitionV1 = { version: 1, id: "pre-admission", name: "Pre-admission", root: {
      type: "agent", id: "work", instructions: "Run once admitted",
    } }
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      id, workspaceId: "workspace", workspaceLineageId: "lineage", workspacePath: "C:/workspace",
      objective: "Resume safely", status: "running", rootSessionId: "root", steps: [], revision: 1,
      definitionId: definition.id, definitionRevision: 1, definitionSnapshot: definition, inputs: {},
      usage: { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      executionNodes: [{ id: "execution", instanceKey: "work", definitionNodeId: "work", type: "agent",
        status: "running", attempt: 0, startedAt: now }], createdAt: now, updatedAt: now,
    }), "utf8")
    let prompts = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: "admitted" } }),
      prompt: async () => { prompts++; return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } } },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      const recovered = (await manager.get(id))!
      assert.equal(recovered.status, "interrupted")
      assert.equal(recovered.executionNodes?.[0]?.status, "waiting")
      await manager.resume(id)
      await waitFor(manager, id, ["completed"])
      assert.equal(prompts, 1)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("restores completed repeat output when its parent checkpoint was interrupted", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-repeat-recovery-"))
    const id = "00000000-0000-4000-8000-000000000092"
    const now = new Date().toISOString()
    const definition: WorkflowDefinitionV1 = { version: 1, id: "repeat-recovery", name: "Repeat recovery", root: {
      type: "repeat", id: "retry", maxIterations: 1,
      while: { value: { $ref: "nodes.work.output" }, notEquals: "done" }, onExhausted: "fail",
      body: { type: "agent", id: "work", instructions: "Work" },
    } }
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      id, workspaceId: "workspace", workspaceLineageId: "lineage", workspacePath: "C:/workspace",
      objective: "Recover repeat", status: "running", rootSessionId: "root", steps: [], revision: 1,
      definitionId: definition.id, definitionRevision: 1, definitionSnapshot: definition, inputs: {},
      usage: { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      executionNodes: [
        { id: "repeat", instanceKey: "retry", definitionNodeId: "retry", type: "repeat", status: "running", attempt: 0, startedAt: now },
        { id: "work", instanceKey: "retry/work[0]", parentInstanceKey: "retry", definitionNodeId: "work", type: "agent",
          status: "completed", attempt: 1, output: "done", startedAt: now, completedAt: now },
      ], createdAt: now, updatedAt: now,
    }), "utf8")
    const client = { tool: workflowTools, session: {
      create: async () => { throw new Error("completed repeat body must not run again") },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      assert.equal((await manager.get(id))?.status, "interrupted")
      await manager.resume(id)
      const completed = await waitFor(manager, id, ["completed"])
      assert.deepEqual(completed.executionNodes?.find((node) => node.id === "repeat")?.output, ["done"])
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("never repeats crash-interrupted actions without persisted termination evidence", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-no-recovery-evidence-"))
    const id = "00000000-0000-4000-8000-000000000096"
    const now = new Date().toISOString()
    const definition: WorkflowDefinitionV1 = { version: 1, id: "no-evidence", name: "No evidence", root: {
      type: "agent", id: "work", instructions: "Do not repeat",
    } }
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      id, workspaceId: "workspace", workspaceLineageId: "lineage", workspacePath: "C:/workspace",
      objective: "No repeat", status: "running", rootSessionId: "root", steps: [], revision: 1,
      definitionId: definition.id, definitionRevision: 1, definitionSnapshot: definition, inputs: {},
      usage: { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      executionNodes: [{ id: "execution", instanceKey: "work", definitionNodeId: "work", type: "agent",
        status: "running", attempt: 1, startedAt: now }], createdAt: now, updatedAt: now,
    }), "utf8")
    let prompts = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: "unexpected" } }),
      prompt: async () => { prompts++; return { data: { info: usage(), parts: [] } } },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      assert.equal((await manager.get(id))?.status, "recovery_required")
      const recovered = (await manager.get(id))!
      await assert.rejects(manager.resume(id, true, recovered.revision), /no persisted session IDs.*will not be repeated/)
      assert.equal((await manager.get(id))?.status, "recovery_required")
      assert.equal(prompts, 0)
      await assert.rejects(manager.start({ workspaceId: "workspace", objective: "blocked", stages: [] }), /already running/)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("restores durable reservation state when cancel and resume persistence fail", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-transition-rollback-"))
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `rollback-${++sessions}` } }),
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "rollback", name: "Rollback", root: {
        type: "gate", id: "gate", gate: "approval", prompt: "Wait",
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "rollback" })
      const waiting = await waitFor(manager, started.id, ["waiting_for_review"])
      const persist = (manager as any).persist.bind(manager)
      let failCancel = true
      ;(manager as any).persist = async (run: WorkflowRun, touch?: boolean) => {
        if (failCancel && run.status === "cancelled") { failCancel = false; throw new Error("cancel write failed") }
        return persist(run, touch)
      }
      await assert.rejects(manager.cancel(started.id), /cancel write failed/)
      assert.equal((await manager.get(started.id))?.status, "waiting_for_review")
      await assert.rejects(manager.start({ workspaceId: "workspace", definitionId: "rollback" }), /already running/)

      let failResume = true
      ;(manager as any).persist = async (run: WorkflowRun, touch?: boolean) => {
        if (failResume && run.status === "running") { failResume = false; throw new Error("resume write failed") }
        return persist(run, touch)
      }
      await assert.rejects(manager.answer(started.id, waiting.pendingGate!.executionNodeId, true), /resume write failed/)
      const restored = await manager.get(started.id)
      assert.equal(restored?.status, "waiting_for_review")
      assert.equal(restored?.pendingGate?.executionNodeId, waiting.pendingGate!.executionNodeId)
      await assert.rejects(manager.start({ workspaceId: "workspace", definitionId: "rollback" }), /already running/)
      ;(manager as any).persist = persist
      assert.equal((await manager.cancel(started.id))?.status, "cancelled")
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("blocks at exact observed budget and rejects malformed SDK usage", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-strict-budget-"))
    let prompts = 0
    let sessions = 0
    let invalid = false
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `strict-${++sessions}` } }),
      prompt: async () => {
        prompts++
        return { data: { info: invalid ? usage(-1, Number.NaN) : usage(0, 10), parts: [{ type: "text", text: "done" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "exact-budget", name: "Exact", budget: { maxTokens: 10 }, root: {
        type: "sequence", id: "root", steps: [
          { type: "agent", id: "one", instructions: "One" }, { type: "agent", id: "two", instructions: "Two" },
        ],
      } })
      const exact = await manager.start({ workspaceId: "workspace", definitionId: "exact-budget" })
      const exactRun = await waitFor(manager, exact.id, ["failed"])
      assert.match(exactRun.error ?? "", /reached token budget 10/)
      assert.equal(prompts, 1)

      invalid = true
      await manager.createDefinition({ version: 1, id: "invalid-usage", name: "Invalid usage", root: {
        type: "agent", id: "work", instructions: "Work",
      } })
      const malformed = await manager.start({ workspaceId: "workspace", definitionId: "invalid-usage" })
      const malformedRun = await waitFor(manager, malformed.id, ["failed"])
      assert.match(malformedRun.error ?? "", /usage .* must be finite and non-negative/)
      assert.equal(malformedRun.usage?.cost, 0)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("fails usage addition before a non-finite value can be persisted", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-usage-overflow-"))
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `overflow-${++sessions}` } }),
      prompt: async () => ({ data: {
        info: { role: "assistant", cost: 0, tokens: {
          input: Number.MAX_VALUE, output: Number.MAX_VALUE, reasoning: 0, cache: { read: 0, write: 0 },
        } },
        parts: [{ type: "text", text: "done" }],
      } }),
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "usage-overflow", name: "Usage overflow", root: {
        type: "agent", id: "work", instructions: "Work",
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "usage-overflow" })
      const run = await waitFor(manager, started.id, ["failed"])
      assert.match(run.error ?? "", /usage tokens.total overflowed/)
      assert.equal(run.usage?.tokens, 0)
      assert.doesNotMatch(await fs.readFile(path.join(directory, `${started.id}.json`), "utf8"), /"tokens": null/)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("validates provider structured output and bounds resolved action context", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-output-context-"))
    let prompts = 0
    let sessions = 0
    const seen: string[] = []
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `validation-${++sessions}` } }),
      prompt: async (input: Record<string, unknown>) => {
        prompts++
        seen.push(JSON.stringify(input.parts))
        return { data: { info: { ...usage(), structured: { count: "wrong" } }, parts: [] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "schema-check", name: "Schema", root: {
        type: "agent", id: "work", instructions: "Work", outputSchema: {
          type: "object", required: ["count"], properties: { count: { type: "number" } },
        },
      } })
      const structured = await manager.start({ workspaceId: "workspace", definitionId: "schema-check" })
      assert.match((await waitFor(manager, structured.id, ["failed"])).error ?? "", /Structured output is invalid/)

      await manager.createDefinition({ version: 1, id: "context-check", name: "Context", root: {
        type: "agent", id: "work", instructions: "Work", context: { $ref: "inputs.payload" },
      } })
      const oversized = await manager.start({ workspaceId: "workspace", definitionId: "context-check", inputs: { payload: "x".repeat(256_001) } })
      assert.match((await waitFor(manager, oversized.id, ["failed"])).error ?? "", /context exceeds 256000 bytes/)
      await manager.createDefinition({ version: 1, id: "own-ref", name: "Own ref", root: {
        type: "agent", id: "work", instructions: "Work", context: { $ref: "inputs.toString" },
      } })
      const inherited = await manager.start({ workspaceId: "workspace", definitionId: "own-ref", inputs: {} })
      await waitFor(manager, inherited.id, ["completed"])
      assert.equal(prompts, 2)
      assert.doesNotMatch(seen.at(-1) ?? "", /Context:/)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("allows bounded aggregate structural output above the action leaf limit", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-structural-output-"))
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `aggregate-${++sessions}` } }),
      prompt: async () => ({ data: { info: usage(), parts: [{ type: "text", text: "x".repeat(9_000) }] } }),
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "aggregate-output", name: "Aggregate", maxConcurrency: 2, root: {
        type: "parallel", id: "root", branches: [
          { type: "agent", id: "one", instructions: "One" }, { type: "agent", id: "two", instructions: "Two" },
        ],
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "aggregate-output" })
      const run = await waitFor(manager, started.id, ["completed"])
      assert.ok(JSON.stringify(run.executionNodes?.find((node) => node.definitionNodeId === "root")?.output).length > 16_000)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("rejects composed expansion and aggregate saved graph bytes before effects", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-composed-limits-"))
    let sessions = 0
    const client = { session: { create: async () => { sessions++; return { data: { id: "unexpected" } } } } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "expansion-child", name: "Child", root: {
        type: "foreach", id: "each", items: [], item: "item", maxItems: 100,
        body: { type: "agent", id: "work", instructions: "Work" },
      } })
      await manager.createDefinition({ version: 1, id: "expansion-parent", name: "Parent", root: {
        type: "foreach", id: "outer", items: [], item: "item", maxItems: 100,
        body: { type: "workflow", id: "child", definitionId: "expansion-child" },
      } })
      await assert.rejects(manager.start({ workspaceId: "workspace", definitionId: "expansion-parent" }), /expand above limit/)

      const byteIds = ["bytes-a", "bytes-b", "bytes-c", "bytes-d", "bytes-e", "bytes-f"]
      for (const id of byteIds) await manager.createDefinition({ version: 1, id, name: id, root: {
        type: "agent", id: "work", instructions: "x".repeat(45_000),
      } })
      await manager.createDefinition({ version: 1, id: "bytes-parent", name: "Bytes", root: {
        type: "sequence", id: "root", steps: byteIds.map((id, index) => ({
          type: "workflow" as const, id: `call-${index}`, definitionId: id,
        })),
      } })
      await assert.rejects(manager.start({ workspaceId: "workspace", definitionId: "bytes-parent" }), /graph exceeds 256000 bytes/)
      assert.equal(sessions, 0)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("fails admission closed for malformed active records and quarantines identifiable ownership", async () => {
    const blockedDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-malformed-global-"))
    await fs.writeFile(path.join(blockedDir, "unknown.json"), "{not json", "utf8")
    const blocked = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: blockedDir })
    try {
      await assert.rejects(blocked.start({ workspaceId: "workspace", objective: "blocked", stages: [] }), /malformed active run unknown.json/)
      assert.equal(await blocked.isWorkspaceWorkflowOwned({ lineageId: "anything" }), true)
    } finally {
      await blocked.shutdown()
      await fs.rm(blockedDir, { recursive: true, force: true })
    }

    const quarantinedDir = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-malformed-lineage-"))
    await fs.writeFile(path.join(quarantinedDir, "known.json"), JSON.stringify({
      id: "known", status: "running", workspaceId: "old", workspaceLineageId: "quarantined", workspacePath: "C:/quarantined",
    }), "utf8")
    const quarantined = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: quarantinedDir })
    try {
      assert.equal(await quarantined.isWorkspaceWorkflowOwned({ lineageId: "quarantined" }), true)
      assert.equal(await quarantined.isWorkspaceWorkflowOwned({ path: "C:/other" }), false)
    } finally {
      await quarantined.shutdown()
      await fs.rm(quarantinedDir, { recursive: true, force: true })
    }
  })

  it("rejects persisted execution types that disagree with the pinned graph", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-pinned-node-type-"))
    const id = "wrong-type"
    const now = new Date().toISOString()
    const definition: WorkflowDefinitionV1 = { version: 1, id: "typed", name: "Typed", root: {
      type: "agent", id: "work", instructions: "Work",
    } }
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      id, workspaceId: "workspace", workspaceLineageId: "typed-lineage", workspacePath: "C:/typed",
      objective: "Typed", status: "paused", steps: [], revision: 1,
      definitionId: definition.id, definitionRevision: 1, definitionSnapshot: definition, inputs: {},
      usage: { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      executionNodes: [{ id: "execution", instanceKey: "work", definitionNodeId: "work", type: "sequence",
        status: "waiting", attempt: 0 }], createdAt: now, updatedAt: now,
    }), "utf8")
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory })
    try {
      await assert.rejects(manager.get(id), /pinned graph/)
      assert.equal(await manager.isWorkspaceWorkflowOwned({ lineageId: "typed-lineage" }), true)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("exposes uncapped canonical ownership leases for retained execution worktrees", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-ownership-"))
    const now = new Date().toISOString()
    for (let index = 0; index < 101; index++) await fs.writeFile(path.join(directory, `done-${index}.json`), JSON.stringify({
      id: `done-${index}`, workspaceId: "old", workspaceLineageId: "old", workspacePath: "C:/old",
      objective: "Done", status: "completed", steps: [], createdAt: now, updatedAt: new Date(Date.now() + index).toISOString(),
    }), "utf8")
    await fs.writeFile(path.join(directory, "owned.json"), JSON.stringify({
      id: "owned", workspaceId: "execution", workspaceLineageId: "execution-lineage", workspacePath: "C:/repo/.worktrees/job",
      objective: "Owned", status: "interrupted", steps: [],
      worktreeSelection: { policy: { mode: "existing", slug: "job" }, sourceWorkspaceId: "source-old",
        sourceWorkspaceLineageId: "source-lineage", sourceWorkspacePath: "C:/repo", workspaceId: "execution",
        directory: "C:/repo/.worktrees/job", slug: "job", created: false },
      createdAt: "2000-01-01T00:00:00.000Z", updatedAt: now,
    }), "utf8")
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory })
    try {
      assert.equal(await manager.isWorkspaceWorkflowOwned({ lineageId: "source-lineage", path: "C:/repo" }), true)
      assert.equal(await manager.isWorkspaceWorkflowOwned({ lineageId: "execution-lineage", path: "C:/repo/.worktrees/job" }), true)
      assert.equal(await manager.isWorktreeWorkflowOwned({ lineageId: "source-lineage" }, { slug: "job" }), true)
      assert.equal(await manager.isWorktreeWorkflowOwned({ lineageId: "wrong-source" }, { path: "C:/repo/.worktrees/job" }), true)
      const leased = await manager.withWorktreeOwnershipLease(
        { path: "C:/repo" }, { path: "C:/repo/.worktrees/job" }, async (owned) => owned,
      )
      assert.equal(leased, true)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("prepares gate execution before consuming it and supports atomic owned cancellation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-gate-prepare-"))
    let ready = true
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `gate-prepare-${++sessions}` } }),
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const ownedWorkspaces = {
      get: (id: string) => id === "wrong-workspace"
        ? { id, lineageId: "wrong-lineage", path: "C:/wrong", status: "ready" }
        : { id, lineageId: "lineage", path: "C:/workspace", status: "ready" },
      list: () => [{ id: "restored", lineageId: "lineage", path: "C:/workspace", status: "ready" }],
    } as unknown as WorkspaceManager
    const manager = new WorkflowManager({ workspaceManager: ownedWorkspaces, eventBus, logger, storageDir: directory, createClient: () => ready ? client : null })
    try {
      await manager.createDefinition({ version: 1, id: "gate-prepare", name: "Gate", root: {
        type: "gate", id: "gate", gate: "approval", prompt: "Approve",
      } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "gate-prepare" })
      const waiting = await waitFor(manager, started.id, ["waiting_for_review"])
      ready = false
      await assert.rejects(manager.answer(started.id, waiting.pendingGate!.executionNodeId, true), /not ready/)
      assert.equal((await manager.get(started.id))?.pendingGate?.executionNodeId, waiting.pendingGate!.executionNodeId)
      assert.equal(await manager.cancelOwned(started.id, "wrong-workspace"), undefined)
      const cancelled = await manager.cancelOwned(started.id, "restored")
      assert.equal(cancelled?.status, "cancelled")
      assert.equal(cancelled?.workspaceId, "restored")
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("uses the persisted bounded legacy output for the next-stage handoff", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-legacy-handoff-"))
    const tail = "UNBOUNDED-TAIL"
    const prompts: string[] = []
    let sessions = 0
    const client = { session: {
      create: async () => ({ data: { id: `legacy-handoff-${++sessions}` } }),
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(JSON.stringify(input.parts))
        return { data: { info: {}, parts: [{ type: "text", text: prompts.length === 1 ? `${"x".repeat(20_000)}${tail}` : "done" }] } }
      },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      const started = await manager.start({ workspaceId: "workspace", objective: "Bound handoff", stages: [
        { id: "one", title: "One", instructions: "One" },
        { id: "two", title: "Two", instructions: "Two" },
      ] })
      const run = await waitFor(manager, started.id, ["completed"])
      assert.equal((run.steps[0]?.output as string).length, 16_000)
      assert.equal(run.steps[0]?.outputTruncated, true)
      assert.doesNotMatch(prompts[1] ?? "", new RegExp(tail))
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("clears a pending gate when a parallel branch fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-gate-branch-failure-"))
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `gate-failure-${++sessions}` } }),
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "gate-branch-failure", name: "Gate branch failure", maxConcurrency: 2,
        root: { type: "parallel", id: "root", maxConcurrency: 2, branches: [
          { type: "gate", id: "gate", gate: "approval", prompt: "Wait" },
          { type: "agent", id: "fail", instructions: "Fail", tools: ["bash"] },
        ] } })
      const started = await manager.start({ workspaceId: "workspace", definitionId: "gate-branch-failure" })
      const run = await waitFor(manager, started.id, ["failed"])
      assert.equal(run.pendingGate, undefined)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("retains recovery ownership when a completed action checkpoint fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-action-checkpoint-"))
    let sessions = 0
    let prompts = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `action-checkpoint-${++sessions}` } }),
      prompt: async () => { prompts++; return { data: { info: usage(), parts: [{ type: "text", text: "done" }] } } },
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    try {
      await manager.createDefinition({ version: 1, id: "action-checkpoint", name: "Action checkpoint", root: {
        type: "agent", id: "work", instructions: "Work",
      } })
      const persist = (manager as any).persist.bind(manager)
      let failCheckpoint = true
      ;(manager as any).persist = async (run: WorkflowRun, touch?: boolean) => {
        const action = run.executionNodes?.find((node) => node.definitionNodeId === "work")
        if (failCheckpoint && run.status === "running" && action?.status === "completed") {
          failCheckpoint = false
          throw new Error("action checkpoint failed")
        }
        return persist(run, touch)
      }
      const started = await manager.start({ workspaceId: "workspace", definitionId: "action-checkpoint" })
      const recovery = await waitFor(manager, started.id, ["recovery_required"])
      assert.equal(recovery.executionNodes?.find((node) => node.definitionNodeId === "work")?.status, "completed")
      await assert.rejects(manager.start({ workspaceId: "workspace", definitionId: "action-checkpoint" }), /already running/)
      assert.equal((await manager.cancel(started.id))?.status, "cancelled")
      assert.equal(prompts, 1)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("retains the reservation when terminal and fallback persistence both fail", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-terminal-persist-"))
    let sessions = 0
    const client = { tool: workflowTools, session: {
      create: async () => ({ data: { id: `terminal-persist-${++sessions}` } }),
      prompt: async () => ({ data: { info: usage(), parts: [{ type: "text", text: "done" }] } }),
      abort: async () => ({ data: true }),
    } } as unknown as OpencodeClient
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
    let reloaded: WorkflowManager | undefined
    try {
      await manager.createDefinition({ version: 1, id: "terminal-persist", name: "Terminal persist", root: {
        type: "agent", id: "work", instructions: "Work",
      } })
      const persist = (manager as any).persist.bind(manager)
      ;(manager as any).persist = async (run: WorkflowRun, touch?: boolean) => {
        if (run.status === "completed" || run.status === "failed" || run.status === "recovery_required") throw new Error("terminal write failed")
        return persist(run, touch)
      }
      const started = await manager.start({ workspaceId: "workspace", definitionId: "terminal-persist" })
      for (let attempt = 0; attempt < 200 && !(manager as any).activeRuns.get(started.id)?.releaseBlocked; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.equal((manager as any).activeRuns.get(started.id)?.releaseBlocked, true)
      const recovery = await manager.get(started.id)
      assert.equal(recovery?.status, "recovery_required")
      assert.equal(recovery?.pendingGate, undefined)
      assert.equal(await fs.stat(path.join(directory, `${started.id}.recovery`)).then(() => true), true)
      await assert.rejects(manager.start({ workspaceId: "workspace", definitionId: "terminal-persist" }), /already running/)
      ;(manager as any).persist = persist
      reloaded = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory, createClient: () => client })
      assert.equal((await reloaded.get(started.id))?.status, "recovery_required")
      await assert.rejects(reloaded.start({ workspaceId: "workspace", definitionId: "terminal-persist" }), /already running/)
      assert.equal((await reloaded.cancel(started.id))?.status, "cancelled")
      const replacement = await reloaded.start({ workspaceId: "workspace", definitionId: "terminal-persist" })
      await waitFor(reloaded, replacement.id, ["completed"])
    } finally {
      await manager.shutdown()
      await reloaded?.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("uses a recovery marker instead of admitting an older waiting snapshot", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-recovery-marker-"))
    const id = "00000000-0000-4000-8000-000000000094"
    const now = new Date().toISOString()
    const definition: WorkflowDefinitionV1 = { version: 1, id: "marked-gate", name: "Marked gate", root: {
      type: "gate", id: "gate", gate: "approval", prompt: "Do not approve",
    } }
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      id, workspaceId: "workspace", workspaceLineageId: "lineage", workspacePath: "C:/workspace",
      objective: "Marked", status: "waiting_for_review", steps: [], revision: 2,
      definitionId: definition.id, definitionRevision: 1, definitionSnapshot: definition, inputs: {},
      usage: { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      executionNodes: [{ id: "execution", instanceKey: "gate", definitionNodeId: "gate", type: "gate",
        status: "waiting", attempt: 0, startedAt: now }],
      pendingGate: { executionNodeId: "execution", definitionNodeId: "gate", gate: "approval", prompt: "Do not approve" },
      createdAt: now, updatedAt: now,
    }), "utf8")
    await fs.writeFile(path.join(directory, `${id}.recovery`), JSON.stringify({ runId: id }), "utf8")
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory })
    try {
      const run = await manager.get(id)
      assert.equal(run?.status, "recovery_required")
      assert.equal(run?.pendingGate, undefined)
      await assert.rejects(manager.approve(id, "execution"), /not waiting for approval/)
      await assert.rejects(manager.start({ workspaceId: "workspace", objective: "blocked", stages: [] }), /already running/)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("ignores a recovery marker superseded by a newer durable run revision", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-stale-recovery-marker-"))
    const id = "00000000-0000-4000-8000-000000000091"
    const now = new Date().toISOString()
    const definition: WorkflowDefinitionV1 = { version: 1, id: "resolved-marker", name: "Resolved marker", root: {
      type: "agent", id: "work", instructions: "Done",
    } }
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      id, workspaceId: "workspace", workspaceLineageId: "lineage", workspacePath: "C:/workspace",
      objective: "Resolved", status: "completed", steps: [], revision: 5,
      definitionId: definition.id, definitionRevision: 1, definitionSnapshot: definition, inputs: {},
      usage: { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      executionNodes: [{ id: "execution", instanceKey: "work", definitionNodeId: "work", type: "agent",
        status: "completed", attempt: 1, output: "done", startedAt: now, completedAt: now }],
      createdAt: now, updatedAt: now,
    }), "utf8")
    await fs.writeFile(path.join(directory, `${id}.recovery`), JSON.stringify({ runId: id, revision: 4 }), "utf8")
    const manager = new WorkflowManager({ workspaceManager, eventBus, logger, storageDir: directory })
    try {
      assert.equal((await manager.get(id))?.status, "completed")
      await assert.rejects(fs.access(path.join(directory, `${id}.recovery`)), /ENOENT/)
    } finally {
      await manager.shutdown()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
