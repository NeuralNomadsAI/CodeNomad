import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { WorkflowRun, WorkflowRunCreateRequest, WorkflowRunStep } from "../api-types"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import { createInstanceClient } from "../workspaces/instance-client"
import type { WorkspaceManager } from "../workspaces/manager"

const PROMPT_TIMEOUT_MS = 30 * 60 * 1000
const ABORT_TIMEOUT_MS = 5_000
const SHUTDOWN_TIMEOUT_MS = 10_000
const MAX_OUTPUT_CHARS = 16_000
const WORKFLOW_HISTORY_LIMIT = 100

export class WorkflowRunError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
  }
}

interface WorkflowManagerOptions {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
  storageDir: string
  createClient?: (workspaceId: string) => OpencodeClient | null
  promptTimeoutMs?: number
}

interface ActiveRun {
  run: WorkflowRun
  client: OpencodeClient
  activeSessionId?: string
  cancelRequested: boolean
  completion?: Promise<void>
  abortController: AbortController
  releaseBlocked: boolean
}

class WorkflowCancelledError extends Error {}

export class WorkflowManager {
  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly activeWorkspaces = new Map<string, string>()
  private readonly reservedLineages = new Map<string, string>()
  private readonly persistQueues = new Map<string, Promise<void>>()
  private readonly transitionQueues = new Map<string, Promise<void>>()
  private readonly createClient: (workspaceId: string) => OpencodeClient | null
  private readonly promptTimeoutMs: number
  private readonly initialized: Promise<void>
  private shuttingDown = false
  private shutdownPromise?: Promise<void>

  constructor(private readonly options: WorkflowManagerOptions) {
    this.promptTimeoutMs = options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS
    this.createClient = options.createClient
      ?? ((workspaceId) => createInstanceClient(options.workspaceManager, workspaceId, { timeoutMs: this.promptTimeoutMs }))
    this.initialized = this.recoverInterruptedRuns()
  }

  async start(input: WorkflowRunCreateRequest): Promise<WorkflowRun> {
    await this.initialized
    const client = this.requireReadyClient(input.workspaceId)
    const workspace = this.options.workspaceManager.get(input.workspaceId)!

    const now = new Date().toISOString()
    const run: WorkflowRun = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      workspaceLineageId: workspace.lineageId ?? workspace.id,
      workspacePath: workspace.path,
      ...(input.initiatorSessionId ? { initiatorSessionId: input.initiatorSessionId } : {}),
      objective: input.objective,
      status: "running",
      steps: input.stages.map((stage) => ({ ...stage, status: "pending" })),
      createdAt: now,
      updatedAt: now,
    }
    const active: ActiveRun = {
      run, client, cancelRequested: false, abortController: new AbortController(), releaseBlocked: false,
    }
    this.reserve(active)
    try {
      await this.persist(run)
    } catch (error) {
      this.release(active)
      throw error
    }
    if (active.cancelRequested || this.shuttingDown) {
      this.release(active)
      return run
    }
    this.launch(active, (current) => this.executePendingStages(current))
    return run
  }

  async get(runId: string, workspaceId?: string): Promise<WorkflowRun | undefined> {
    await this.initialized
    const active = this.activeRuns.get(runId)
    if (!active) {
      const run = await this.read(runId)
      return workspaceId && run ? this.bindWorkspace(run, workspaceId) : run
    }
    if (["waiting_for_review", "completed", "failed", "cancelled"].includes(active.run.status)) {
      await active.completion
      const run = await this.read(runId) ?? active.run
      return workspaceId ? this.bindWorkspace(run, workspaceId) : run
    }
    return workspaceId ? this.bindWorkspace(active.run, workspaceId) : active.run
  }

  async list(workspaceId?: string): Promise<WorkflowRun[]> {
    await this.initialized
    let entries: string[]
    try {
      entries = await fs.readdir(this.options.storageDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const runs = await Promise.all(entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => this.read(entry.slice(0, -5))))
    const matched: WorkflowRun[] = []
    for (const run of runs) {
      if (!run) continue
      const bound = workspaceId ? await this.bindWorkspace(run, workspaceId) : run
      if (bound) matched.push(bound)
    }
    return matched.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, WORKFLOW_HISTORY_LIMIT)
  }

  async approve(runId: string): Promise<WorkflowRun | undefined> {
    await this.initialized
    return this.withRunTransition(runId, async () => {
      const current = this.activeRuns.get(runId)
      if (current?.run.status === "waiting_for_review") await current.completion
      else if (current) {
        throw new WorkflowRunError("Workflow stage is not ready for review", 409)
      }
      const run = await this.read(runId)
      if (!run) return undefined
      const reviewed = run.steps.find((step) => step.id === run.pendingReviewStepId)
      if (run.status !== "waiting_for_review" || reviewed?.status !== "completed") {
        throw new WorkflowRunError("Workflow run is not waiting for review", 409)
      }

      const restoredWorkspace = this.options.workspaceManager.list().find((workspace) =>
        workspace.lineageId === run.workspaceLineageId && workspace.status === "ready")
      if (restoredWorkspace && restoredWorkspace.id !== run.workspaceId) {
        await this.bindWorkspace(run, restoredWorkspace.id)
      }
      const client = this.requireReadyClient(run.workspaceId, run.id)
      run.status = "running"
      delete run.pendingReviewStepId
      delete run.error
      const active: ActiveRun = {
        run, client, cancelRequested: false, abortController: new AbortController(), releaseBlocked: false,
      }
      this.reserve(active)
      try {
        await this.persist(run)
      } catch (error) {
        run.status = "waiting_for_review"
        this.release(active)
        throw error
      }
      if (active.cancelRequested || this.shuttingDown) {
        this.release(active)
        return run
      }
      this.launch(active, (current) => this.executePendingStages(current))
      return run
    })
  }

  async cancel(runId: string): Promise<WorkflowRun | undefined> {
    await this.initialized
    if (this.shuttingDown) throw new WorkflowRunError("CodeNomad is shutting down", 503)
    return this.cancelRun(runId)
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shuttingDown = true
      this.shutdownPromise = this.performShutdown()
    }
    await this.withTimeout(this.shutdownPromise, SHUTDOWN_TIMEOUT_MS, "Workflow shutdown timed out")
  }

  private async cancelRun(runId: string): Promise<WorkflowRun | undefined> {
    return this.withRunTransition(runId, async () => {
      const active = this.activeRuns.get(runId)
      const run = active?.run ?? await this.read(runId)
      if (!run) return undefined
      if (run.status !== "running" && run.status !== "waiting_for_review") return run

      if (active) {
        active.cancelRequested = true
        active.abortController.abort()
        if (active.activeSessionId) {
          const sessionId = active.activeSessionId
          active.activeSessionId = undefined
          if (!await this.abortSession(active, sessionId)) active.releaseBlocked = true
        }
      }
      this.markCancelled(run)
      await this.persist(run)
      if (!active && this.activeWorkspaces.get(run.workspaceId) === run.id) {
        this.activeWorkspaces.delete(run.workspaceId)
      }
      if (this.reservedLineages.get(run.workspaceLineageId) === run.id) {
        this.reservedLineages.delete(run.workspaceLineageId)
      }
      return run
    })
  }

  private async performShutdown(): Promise<void> {
    await this.initialized
    await Promise.all(Array.from(this.transitionQueues.values()))
    const active = Array.from(this.activeRuns.values())
    await Promise.all(active.map(({ run }) => this.cancelRun(run.id)))
    await Promise.all(active.map(({ completion }) => completion))
    await Promise.all(Array.from(this.persistQueues.values()))
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeout: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private requireReadyClient(workspaceId: string, runId?: string): OpencodeClient {
    if (this.shuttingDown) throw new WorkflowRunError("CodeNomad is shutting down", 503)
    const workspace = this.options.workspaceManager.get(workspaceId)
    if (!workspace) throw new WorkflowRunError("Workspace not found", 404)
    if (workspace.status !== "ready") throw new WorkflowRunError("Workspace instance is not ready", 409)
    const activeRunId = this.activeWorkspaces.get(workspaceId)
    if (activeRunId && activeRunId !== runId) {
      throw new WorkflowRunError("A workflow is already running in this workspace", 409)
    }
    const lineageId = workspace.lineageId ?? workspace.id
    const lineageRunId = this.reservedLineages.get(lineageId)
    if (lineageRunId && lineageRunId !== runId) {
      throw new WorkflowRunError("A workflow is already running for this workspace lineage", 409)
    }
    const client = this.createClient(workspaceId)
    if (!client) throw new WorkflowRunError("Workspace instance is not ready", 409)
    return client
  }

  private reserve(active: ActiveRun) {
    this.activeRuns.set(active.run.id, active)
    // ponytail: one run per workspace; add worktree-aware concurrency only when parallel workflows are needed.
    this.activeWorkspaces.set(active.run.workspaceId, active.run.id)
    this.reservedLineages.set(active.run.workspaceLineageId, active.run.id)
  }

  private release(active: ActiveRun) {
    this.activeRuns.delete(active.run.id)
    if (active.releaseBlocked) {
      this.options.logger.error({ runId: active.run.id }, "Retaining workflow reservation after unconfirmed session abort")
      return
    }
    if (active.run.status !== "waiting_for_review" && this.activeWorkspaces.get(active.run.workspaceId) === active.run.id) {
      this.activeWorkspaces.delete(active.run.workspaceId)
    }
    if (active.run.status !== "waiting_for_review" && this.reservedLineages.get(active.run.workspaceLineageId) === active.run.id) {
      this.reservedLineages.delete(active.run.workspaceLineageId)
    }
  }

  private async withRunTransition<T>(runId: string, transition: () => Promise<T>): Promise<T> {
    const previous = this.transitionQueues.get(runId) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(transition)
    const marker = queued.then(() => undefined, () => undefined)
    this.transitionQueues.set(runId, marker)
    try {
      return await queued
    } finally {
      if (this.transitionQueues.get(runId) === marker) this.transitionQueues.delete(runId)
    }
  }

  private launch(active: ActiveRun, execute: (active: ActiveRun) => Promise<void>) {
    active.completion = execute(active)
      .catch((error) => this.handleExecutionError(active, error))
      .catch((error) => {
        this.options.logger.error({ err: error, runId: active.run.id }, "Failed to persist workflow failure")
      })
      .finally(() => this.release(active))
  }

  private async executePendingStages(active: ActiveRun): Promise<void> {
    const { run, client } = active
    if (!run.rootSessionId) {
      const root = await this.requireData(client.session.create({
        ...(run.initiatorSessionId ? { parentID: run.initiatorSessionId } : {}),
        title: `Workflow: ${run.objective.slice(0, 80)}`,
        metadata: this.sessionMetadata(run.id, "workflow"),
      }, { signal: this.operationSignal(active) }), "create workflow session")
      this.throwIfCancelled(active)
      run.rootSessionId = root.id
      await this.persist(run)
    }

    while (true) {
      const index = run.steps.findIndex((step) => step.status === "pending")
      if (index < 0) break
      const step = run.steps[index]!
      const previous = index > 0 ? run.steps[index - 1]?.output : undefined
      await this.runStep(active, step, this.buildStagePrompt(run, step, previous))
      this.throwIfCancelled(active)
      if (step.requiresApproval) {
        run.status = "waiting_for_review"
        run.pendingReviewStepId = step.id
        delete run.activeStepId
        await this.persist(run)
        return
      }
    }

    run.status = "completed"
    delete run.activeStepId
    delete run.pendingReviewStepId
    await this.persist(run)
  }

  private buildStagePrompt(run: WorkflowRun, step: WorkflowRunStep, previous: unknown): string {
    return [
      `Workflow stage: ${step.title}`,
      "",
      `Objective:\n${run.objective}`,
      "",
      `Stage instructions:\n${step.instructions}`,
      ...(previous === undefined ? [] : ["", `Previous stage handoff:\n${JSON.stringify(previous, null, 2)}`]),
    ].join("\n")
  }

  private async runStep(
    active: ActiveRun,
    step: WorkflowRunStep,
    prompt: string,
  ): Promise<unknown> {
    const { run, client } = active
    this.throwIfCancelled(active)
    step.status = "running"
    step.startedAt = new Date().toISOString()
    run.activeStepId = step.id
    await this.persist(run)
    this.throwIfCancelled(active)

    const session = await this.requireData(client.session.create({
      parentID: run.rootSessionId,
      title: `${step.title}: ${run.objective.slice(0, 60)}`,
      ...(step.agent ? { agent: step.agent } : {}),
      metadata: this.sessionMetadata(run.id, step.id),
    }, { signal: this.operationSignal(active) }), `create ${step.title} session`)
    step.sessionId = session.id
    active.activeSessionId = session.id
    this.throwIfCancelled(active)
    await this.persist(run)
    this.throwIfCancelled(active)

    const response = await this.requireData(client.session.prompt({
      sessionID: session.id,
      ...(step.agent ? { agent: step.agent } : {}),
      ...(step.model ? { model: step.model } : {}),
      parts: [{ type: "text", text: prompt }],
    }, { signal: this.operationSignal(active) }), `run ${step.title} session`)
    active.activeSessionId = undefined
    this.throwIfCancelled(active)
    if (response.info.error) throw new Error(this.errorMessage(response.info.error))

    const output = response.info.structured ?? response.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    const bounded = this.boundOutput(output)
    step.output = bounded.output
    step.outputTruncated = bounded.truncated || undefined
    step.status = "completed"
    step.completedAt = new Date().toISOString()
    active.activeSessionId = undefined
    await this.persist(run)
    return output
  }

  private sessionMetadata(runId: string, role: string) {
    return { codenomad: { version: 1, workflow: { runId, role } } }
  }

  private operationSignal(active: ActiveRun): AbortSignal {
    return AbortSignal.any([active.abortController.signal, AbortSignal.timeout(this.promptTimeoutMs)])
  }

  private boundOutput(output: unknown): { output: unknown; truncated: boolean } {
    if (typeof output === "string") {
      return output.length <= MAX_OUTPUT_CHARS
        ? { output, truncated: false }
        : { output: output.slice(0, MAX_OUTPUT_CHARS), truncated: true }
    }
    const serialized = JSON.stringify(output)
    return serialized.length <= MAX_OUTPUT_CHARS
      ? { output, truncated: false }
      : { output: serialized.slice(0, MAX_OUTPUT_CHARS), truncated: true }
  }

  private throwIfCancelled(active: ActiveRun) {
    if (active.cancelRequested) throw new WorkflowCancelledError("Workflow run cancelled")
  }

  private async abortSession(active: ActiveRun, sessionId: string): Promise<boolean> {
    try {
      const response = await active.client.session.abort(
        { sessionID: sessionId },
        { signal: AbortSignal.timeout(ABORT_TIMEOUT_MS) },
      )
      if (response.data === true && response.error === undefined) return true
      this.options.logger.warn({ err: response.error, runId: active.run.id }, "Workflow session abort was not confirmed")
      return false
    } catch (error) {
      this.options.logger.warn({ err: error, runId: active.run.id }, "Failed to abort workflow session")
      return false
    }
  }

  private async handleExecutionError(active: ActiveRun, error: unknown): Promise<void> {
    const { run } = active
    if (active.activeSessionId) {
      const sessionId = active.activeSessionId
      active.activeSessionId = undefined
      if (!await this.abortSession(active, sessionId)) active.releaseBlocked = true
    }
    if (active.cancelRequested || error instanceof WorkflowCancelledError) {
      this.markCancelled(run)
    } else {
      const message = this.errorMessage(error)
      run.status = "failed"
      run.error = message
      const step = run.steps.find((candidate) => candidate.status === "running")
      if (step) {
        step.status = "failed"
        step.error = message
        step.completedAt = new Date().toISOString()
      }
      delete run.activeStepId
      this.options.logger.error({ err: error, runId: run.id }, "Workflow run failed")
    }
    await this.persist(run)
  }

  private markCancelled(run: WorkflowRun) {
    run.status = "cancelled"
    const step = run.steps.find((candidate) => candidate.status === "running")
    if (step) {
      step.status = "cancelled"
      step.completedAt = new Date().toISOString()
    }
    delete run.activeStepId
    delete run.pendingReviewStepId
  }

  private async requireData<T>(request: Promise<{ data?: T; error?: unknown }>, action: string): Promise<T> {
    const response = await request
    if (response.data !== undefined) return response.data
    throw new Error(`${action} failed: ${this.errorMessage(response.error)}`)
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    try {
      return JSON.stringify(error) || "Unknown error"
    } catch {
      return "Unknown error"
    }
  }

  private runPath(runId: string) {
    return path.join(this.options.storageDir, `${runId}.json`)
  }

  private async bindWorkspace(run: WorkflowRun, workspaceId: string): Promise<WorkflowRun | undefined> {
    if (run.workspaceId === workspaceId) return run
    const workspace = this.options.workspaceManager.get(workspaceId)
    if (!workspace || !workspace.lineageId || run.workspaceLineageId !== workspace.lineageId) return undefined
    const previousId = run.workspaceId
    run.workspaceId = workspaceId
    if (this.activeWorkspaces.get(previousId) === run.id) this.activeWorkspaces.delete(previousId)
    if (run.status === "waiting_for_review") this.activeWorkspaces.set(workspaceId, run.id)
    await this.persist(run, false)
    return run
  }

  private async read(runId: string): Promise<WorkflowRun | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.runPath(runId), "utf8")) as WorkflowRun
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  private async recoverInterruptedRuns(): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.options.storageDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }

    for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
      try {
        const run = await this.read(entry.slice(0, -5))
        if (!run) continue
        if (run.status === "waiting_for_review") {
          this.reservedLineages.set(run.workspaceLineageId, run.id)
          continue
        }
        if (run.status !== "running") continue
        run.status = "interrupted"
        run.error = "CodeNomad restarted before this workflow completed"
        const step = run.steps.find((candidate) => candidate.status === "running")
        if (step) {
          step.status = "failed"
          step.error = run.error
          step.completedAt = new Date().toISOString()
        }
        delete run.activeStepId
        await this.persist(run)
      } catch (error) {
        this.options.logger.error({ err: error, file: entry }, "Failed to recover workflow run")
      }
    }
  }

  private async persist(run: WorkflowRun, touch = true): Promise<void> {
    if (touch) run.updatedAt = new Date().toISOString()
    const snapshot = JSON.parse(JSON.stringify(run)) as WorkflowRun
    const previous = this.persistQueues.get(run.id) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(async () => {
      await fs.mkdir(this.options.storageDir, { recursive: true })
      const destination = this.runPath(run.id)
      const temporary = `${destination}.${randomUUID()}.tmp`
      await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
      await fs.rename(temporary, destination)
      this.options.eventBus.publish({
        type: "instance.event",
        instanceId: snapshot.workspaceId,
        event: { type: "workflow.run.updated", properties: { run: snapshot } },
      })
      if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot.status)) {
        await this.pruneHistory(snapshot.workspaceLineageId).catch((error) => {
          this.options.logger.warn({ err: error, runId: snapshot.id }, "Failed to prune workflow history")
        })
      }
    })
    this.persistQueues.set(run.id, queued)
    try {
      await queued
    } finally {
      if (this.persistQueues.get(run.id) === queued) this.persistQueues.delete(run.id)
    }
  }

  private async pruneHistory(workspaceLineageId: string): Promise<void> {
    const entries = await fs.readdir(this.options.storageDir)
    const runs = (await Promise.all(entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => this.read(entry.slice(0, -5)))))
      .filter((run): run is WorkflowRun => Boolean(
        run
        && run.workspaceLineageId === workspaceLineageId
        && ["completed", "failed", "cancelled", "interrupted"].includes(run.status),
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    await Promise.all(runs.slice(WORKFLOW_HISTORY_LIMIT).map((run) => fs.rm(this.runPath(run.id), { force: true })))
  }
}
