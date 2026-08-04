import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type {
  WorkflowDefinitionV1,
  WorkflowDefinitionRecord,
  WorkflowDefinitionRunCreateRequest,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunStartRequest,
  WorkflowRunStep,
  WorkflowRunWorktreePolicy,
  WorkflowRunWorktreeSelection,
  WorkflowSavedDefinitionSnapshot,
  WorkspaceDescriptor,
} from "../api-types"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import { createInstanceClient } from "../workspaces/instance-client"
import { createManagedWorktree, isManagedWorktree, isValidWorktreeSlug, listWorktrees, resolveRepoRoot } from "../workspaces/git-worktrees"
import type { WorkspaceManager } from "../workspaces/manager"
import { probePosixProcesses, probeWindowsProcesses } from "../workspaces/process-identity"
import { ensureCodenomadGitExclude } from "../workspaces/worktree-map"
import { WorkflowDefinitionStore } from "./definition-store"
import { validateWorkflowDefinition, WORKFLOW_LIMITS } from "./definition-schema"
import { withFilesystemLock } from "./filesystem-lock"
import { WorkflowCheckpointError, WorkflowInterpreter, WorkflowSuspendedError } from "./interpreter"
import { validateJsonSchemaValue } from "./json-schema"
import { definitionRunFields, holdsWorkflowReservation, markWorkflowRecoveryRequired, validatePersistedWorkflowRun } from "./run-state"

const PROMPT_TIMEOUT_MS = 30 * 60 * 1000
const ABORT_TIMEOUT_MS = 5_000
const SHUTDOWN_TIMEOUT_MS = 10_000
const MAX_OUTPUT_CHARS = 16_000
const WORKFLOW_HISTORY_LIMIT = 100
const CREATION_CLEANUP_ATTEMPTS = 3
const EXECUTOR_LEASE_MS = 10_000
const EXECUTOR_HEARTBEAT_MS = 2_500
const READ_REFRESH_MS = 250
const PROCESS_OWNER = currentProcessOwner()

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
  definitionsDir?: string
  createClient?: (workspaceId: string) => OpencodeClient | null
  promptTimeoutMs?: number
}

interface ActiveRun {
  run: WorkflowRun
  client: OpencodeClient
  activeSessionId?: string
  activeSessionIds: Set<string>
  abortingSessions: Map<string, Promise<boolean>>
  cancelRequested: boolean
  completion?: Promise<void>
  abortController: AbortController
  releaseBlocked: boolean
  pauseCommitted: boolean
  leaseFence: number
  leaseLost: boolean
  leaseDurablyReleased: boolean
  heartbeat?: NodeJS.Timeout
}

interface DefinitionGraphSnapshot {
  root: WorkflowDefinitionV1
  saved: WorkflowSavedDefinitionSnapshot[]
}

interface RunIndexEntry {
  id: string
  workspaceId: string
  workspaceLineageId: string
  workspacePath: string
  sourceWorkspaceId?: string
  sourceWorkspaceLineageId?: string
  sourceWorkspacePath?: string
  worktreeDirectory?: string
  worktreeSlug?: string
  status: WorkflowRun["status"]
  createdAt: string
  updatedAt: string
  ambiguousSessions: boolean
}

interface RunFileMetadata extends RunIndexEntry {
  size: number
  mtimeMs: number
}

export interface WorkflowWorkspaceIdentity {
  id?: string
  lineageId?: string
  path?: string
}

export interface WorkflowWorktreeIdentity {
  slug?: string
  path?: string
}

class WorkflowCancelledError extends Error {}

export class WorkflowManager {
  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly activeWorkspaces = new Map<string, string>()
  private readonly reservedLineages = new Map<string, string>()
  private readonly reservedPaths = new Map<string, string>()
  private readonly persistQueues = new Map<string, Promise<void>>()
  private readonly transitionQueues = new Map<string, Promise<void>>()
  private readonly deferredCreationCleanups = new Map<string, number>()
  private readonly quarantinedWorktrees: Array<Partial<RunIndexEntry>> = []
  private readonly runIndex = new Map<string, RunIndexEntry>()
  private readonly shutdownAbortController = new AbortController()
  private readonly createClient: (workspaceId: string) => OpencodeClient | null
  private readonly promptTimeoutMs: number
  private readonly managerToken = randomUUID()
  private readonly processOwner = PROCESS_OWNER
  private initialized?: Promise<void>
  private readRefresh?: Promise<void>
  private lastReadRefreshAt = 0
  private readonly definitionStore: WorkflowDefinitionStore
  private admissionQueue = Promise.resolve()
  private creationCleanupQueue = Promise.resolve()
  private shuttingDown = false
  private shutdownPromise?: Promise<void>
  private admissionFailure?: string

  constructor(private readonly options: WorkflowManagerOptions) {
    this.promptTimeoutMs = options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS
    this.createClient = options.createClient
      ?? ((workspaceId) => createInstanceClient(options.workspaceManager, workspaceId, { timeoutMs: WORKFLOW_LIMITS.timeoutMs }))
    this.definitionStore = new WorkflowDefinitionStore(
      options.definitionsDir ?? path.join(options.storageDir, "definitions"),
    )
  }

  async start(input: WorkflowRunStartRequest): Promise<WorkflowRun> {
    await this.ensureInitialized()
    this.throwIfShuttingDown()
    try {
      return await this.withAdmission(() => this.startAdmitted(input))
    } finally {
      await this.drainCreationCleanups()
    }
  }

  async startLatest(input: WorkflowDefinitionRunCreateRequest): Promise<WorkflowRun> {
    await this.ensureInitialized()
    this.throwIfShuttingDown()
    try {
      return await this.withAdmission(async () => {
        const current = await this.definitionStore.get(input.definitionId)
        if (!current) throw new WorkflowRunError("Workflow definition not found", 404)
        if (input.definitionRevision !== undefined && current.revision !== input.definitionRevision) {
          throw new WorkflowRunError("Workflow definition revision is stale", 409)
        }
        return this.startAdmitted({ ...input, definitionRevision: current.revision })
      })
    } finally {
      await this.drainCreationCleanups()
    }
  }

  private async startAdmitted(input: WorkflowRunStartRequest): Promise<WorkflowRun> {
    this.throwIfShuttingDown()
    this.throwIfAdmissionBlocked()
    const legacy = "stages" in input
    if (!legacy && input.runId) {
      const existing = this.activeRuns.get(input.runId)?.run ?? await this.read(input.runId)
      if (existing) return this.idempotentStart(existing, input)
    }
    const definition = legacy ? undefined : await this.definitionStore.get(input.definitionId, input.definitionRevision)
    if (!legacy && !definition) throw new WorkflowRunError("Workflow definition not found", 404)
    const graph = definition ? await this.snapshotDefinitionGraph(definition) : undefined
    this.throwIfShuttingDown()
    const selected = legacy
      ? this.currentWorkspace(input.workspaceId)
      : await this.selectWorktree(input, input.worktree ?? { mode: "current" })
    const workspace = selected.workspace
    const creationRequest = "creationRequest" in selected ? selected.creationRequest : undefined
    let active: ActiveRun | undefined
    let persisted = false
    let retained = !creationRequest
    try {
      await this.assertNoPersistedReservation(workspace)
      const client = this.requireReadyClient(workspace.id)
      const now = new Date().toISOString()
      const run: WorkflowRun = {
        id: !legacy && input.runId ? input.runId : randomUUID(),
        workspaceId: workspace.id,
        workspaceLineageId: workspace.lineageId ?? workspace.id,
        workspacePath: workspace.path,
        ...(input.initiatorSessionId ? { initiatorSessionId: input.initiatorSessionId } : {}),
        objective: input.objective ?? definition!.definition.name,
        status: "running",
        steps: legacy ? input.stages.map((stage) => ({ ...stage, status: "pending" })) : [],
        revision: 0,
        ...(definition && !("stages" in input) ? {
          ...definitionRunFields(definition, input),
          definitionSnapshot: graph!.root,
          savedDefinitionSnapshots: graph!.saved,
          worktreeSelection: selected.selection,
        } : {}),
        createdAt: now,
        updatedAt: now,
      }
      this.claimExecutor(run)
      active = {
        run, client, activeSessionIds: new Set(), abortingSessions: new Map(), cancelRequested: false,
        abortController: new AbortController(), releaseBlocked: false, pauseCommitted: false,
        leaseFence: run.executorFence!, leaseLost: false, leaseDurablyReleased: false,
      }
      this.reserve(active)
      await this.persist(run)
      persisted = true
      if (creationRequest) {
        this.throwIfShuttingDown()
        if (!this.options.workspaceManager.releaseCreationRequest(creationRequest.workspaceId, creationRequest.requestId)) {
          throw new WorkflowRunError("Managed worktree workspace ownership could not be retained; the workflow was not started", 500)
        }
        retained = true
      }
      this.launch(active, (current) => legacy ? this.executePendingStages(current) : this.executeDefinition(current))
      return run
    } catch (error) {
      if (active && !retained) {
        try {
          if (persisted) {
            await durableRemove(this.runPath(active.run.id))
            await durableRemove(this.runMetadataPath(active.run.id))
          }
          this.runIndex.delete(active.run.id)
          this.release(active, true)
        } catch (rollbackError) {
          active.releaseBlocked = true
          this.admissionFailure = `Workflow admission is blocked because startup rollback failed for run ${active.run.id}; remove or repair it and restart CodeNomad`
          this.options.logger.error({ err: rollbackError, runId: active.run.id }, "Failed to roll back workflow startup")
        }
      } else if (active && !persisted) {
        this.release(active, true)
      }
      throw error
    } finally {
      if (creationRequest && !retained) this.deferCreationCleanup(creationRequest.requestId)
    }
  }

  private currentWorkspace(workspaceId: string): { workspace: WorkspaceDescriptor; selection?: undefined } {
    const workspace = this.options.workspaceManager.get(workspaceId)
    if (!workspace) throw new WorkflowRunError("Workspace not found", 404)
    if (workspace.status !== "ready") throw new WorkflowRunError("Workspace instance is not ready", 409)
    return { workspace }
  }

  private idempotentStart(existing: WorkflowRun, input: WorkflowDefinitionRunCreateRequest): WorkflowRun {
    const sourceWorkspaceId = existing.worktreeSelection?.sourceWorkspaceId ?? existing.workspaceId
    const requestedPolicy = input.worktree ?? { mode: "current" }
    if (sourceWorkspaceId !== input.workspaceId || existing.definitionId !== input.definitionId
      || (input.definitionRevision !== undefined && existing.definitionRevision !== input.definitionRevision)
      || (input.objective !== undefined && existing.objective !== input.objective)
      || !isDeepStrictEqual(existing.inputs ?? {}, input.inputs ?? {})
      || !isDeepStrictEqual(existing.worktreeSelection?.policy ?? { mode: "current" }, requestedPolicy)) {
      throw new WorkflowRunError("Workflow run ID already belongs to another start request", 409)
    }
    return existing
  }

  private async selectWorktree(
    input: WorkflowDefinitionRunCreateRequest,
    policy: WorkflowRunWorktreePolicy,
  ): Promise<{
    workspace: WorkspaceDescriptor
    selection: WorkflowRunWorktreeSelection
    creationRequest?: { workspaceId: string; requestId: string }
  }> {
    const source = this.currentWorkspace(input.workspaceId).workspace
    if (policy.mode === "current") return {
      workspace: source,
      selection: {
        policy,
        sourceWorkspaceId: source.id,
        sourceWorkspaceLineageId: source.lineageId ?? source.id,
        sourceWorkspacePath: source.path,
        workspaceId: source.id,
        directory: source.path,
        created: false,
      },
    }
    if (input.initiatorSessionId) {
      throw new WorkflowRunError("initiatorSessionId is unsupported when a workflow selects a different worktree workspace", 400)
    }
    if (!isValidWorktreeSlug(policy.slug) || policy.slug === "root") {
      throw new WorkflowRunError("Invalid workflow worktree slug", 400)
    }

    let repository
    try {
      repository = await resolveRepoRoot(source.path, this.options.logger, {
        signal: this.shutdownAbortController.signal,
      })
    } catch (error) {
      throw new WorkflowRunError(`Workflow worktree selection is unavailable: ${this.errorMessage(error)}`, 409)
    }
    const { repoRoot, isGitRepo } = repository
    if (!isGitRepo) throw new WorkflowRunError("Workflow worktree policy requires a Git repository", 400)
    let target: { slug: string; directory: string; branch?: string }
    if (policy.mode === "existing") {
      const match = (await listWorktrees({
        repoRoot, workspaceFolder: source.path, logger: this.options.logger,
        signal: this.shutdownAbortController.signal,
      }))
        .find((worktree) => worktree.kind === "worktree" && worktree.slug === policy.slug)
      if (!match) throw new WorkflowRunError(`Managed worktree ${policy.slug} was not found`, 404)
      if (!await isManagedWorktree({ repoRoot, worktree: match })) {
        throw new WorkflowRunError(`Worktree ${policy.slug} is not managed by CodeNomad`, 400)
      }
      target = match
    } else {
      this.throwIfShuttingDown()
      await ensureCodenomadGitExclude(source.path, this.options.logger).catch(() => undefined)
      this.throwIfShuttingDown()
      try {
        target = await createManagedWorktree({
          repoRoot, workspaceFolder: source.path, slug: policy.slug, logger: this.options.logger,
          signal: this.shutdownAbortController.signal,
        })
      } catch (error) {
        throw new WorkflowRunError(`Failed to create managed worktree ${policy.slug}: ${this.errorMessage(error)}`, 409)
      }
    }

    const requestId = `workflow-${randomUUID()}`
    let handedOff = false
    try {
      this.throwIfShuttingDown()
      const createdWorkspace = await this.options.workspaceManager.create(target.directory, `Workflow: ${policy.slug}`, {
        requestId,
        binaryPath: source.binaryId,
      })
      this.throwIfShuttingDown()
      handedOff = true
      return {
        workspace: createdWorkspace.workspace,
        creationRequest: { workspaceId: createdWorkspace.workspace.id, requestId },
        selection: {
          policy,
          sourceWorkspaceId: source.id,
          sourceWorkspaceLineageId: source.lineageId ?? source.id,
          sourceWorkspacePath: source.path,
          workspaceId: createdWorkspace.workspace.id,
          directory: createdWorkspace.workspace.path,
          slug: target.slug,
          ...(target.branch ? { branch: target.branch } : {}),
          created: policy.mode === "new",
        },
      }
    } catch (error) {
      if (error instanceof WorkflowRunError) throw error
      throw new WorkflowRunError(
        `Managed worktree ${policy.slug} was selected, but its OpenCode workspace could not be started: ${this.errorMessage(error)}. The worktree was retained for inspection.`,
        409,
      )
    } finally {
      if (!handedOff) this.deferCreationCleanup(requestId)
    }
  }

  private async snapshotDefinitionGraph(root: WorkflowDefinitionRecord): Promise<DefinitionGraphSnapshot> {
    const saved = new Map<string, WorkflowSavedDefinitionSnapshot>()
    const resolved = new Set<string>()
    const snapshot = async (record: WorkflowDefinitionRecord, stack: string[], depth: number): Promise<WorkflowDefinitionV1> => {
      if (depth > WORKFLOW_LIMITS.nestingDepth) {
        throw new WorkflowRunError(`Saved workflow nesting exceeds maximum depth ${WORKFLOW_LIMITS.nestingDepth}`, 400)
      }
      if (stack.includes(record.id)) {
        throw new WorkflowRunError(`Saved workflow cycle detected: ${[...stack, record.id].join(" -> ")}`, 400)
      }
      const key = `${record.id}@${record.revision}`
      if (resolved.has(key)) return saved.get(key)!.definition
      const definition = JSON.parse(JSON.stringify(record.definition)) as WorkflowDefinitionV1
      const nextStack = [...stack, record.id]
      const inspect = async (node: WorkflowNode): Promise<void> => {
        if (node.type === "workflow") {
          const child = await this.definitionStore.get(node.definitionId, node.definitionRevision)
          if (!child) {
            const revision = node.definitionRevision ? ` revision ${node.definitionRevision}` : ""
            throw new WorkflowRunError(`Referenced workflow definition ${node.definitionId}${revision} was not found`, 404)
          }
          node.definitionRevision = child.revision
          const childDefinition = await snapshot(child, nextStack, depth + 1)
          const childKey = `${child.id}@${child.revision}`
          if (!saved.has(childKey)) saved.set(childKey, { id: child.id, revision: child.revision, definition: childDefinition })
          if (saved.size > WORKFLOW_LIMITS.staticNodes) {
            throw new WorkflowRunError(`Saved workflow graph exceeds ${WORKFLOW_LIMITS.staticNodes} definitions`, 400)
          }
          return
        }
        const children = node.type === "sequence" ? node.steps
          : node.type === "parallel" ? node.branches
            : node.type === "foreach" || node.type === "repeat" ? [node.body]
              : node.type === "condition" ? [node.then, ...(node.else ? [node.else] : [])]
                : []
        for (const child of children) await inspect(child)
      }
      await inspect(definition.root)
      resolved.add(key)
      return definition
    }
    const rootDefinition = await snapshot(root, [], 0)
    saved.delete(`${root.id}@${root.revision}`)
    const snapshots = Array.from(saved.values())
    const graphBytes = Buffer.byteLength(JSON.stringify([rootDefinition, ...snapshots.map((item) => item.definition)]), "utf8")
    if (graphBytes > WORKFLOW_LIMITS.sourceBytes) {
      throw new WorkflowRunError(`Saved workflow graph exceeds ${WORKFLOW_LIMITS.sourceBytes} bytes`, 400)
    }
    const byKey = new Map(snapshots.map((item) => [`${item.id}@${item.revision}`, item.definition]))
    const limit = rootDefinition.maxExpandedNodes ?? WORKFLOW_LIMITS.expandedNodes
    const add = (left: number, right: number) => Math.min(limit + 1, left + right)
    const multiply = (left: number, right: number) => Math.min(limit + 1, left * right)
    const expansionMemo = new Map<string, number>()
    const definitionExpansion = (key: string, definition: WorkflowDefinitionV1): number => {
      const cached = expansionMemo.get(key)
      if (cached !== undefined) return cached
      const result = expansion(definition.root)
      expansionMemo.set(key, result)
      return result
    }
    const expansion = (node: WorkflowNode): number => {
      if (node.type === "workflow") {
        const key = `${node.definitionId}@${node.definitionRevision}`
        const child = byKey.get(key)
        return child ? add(1, definitionExpansion(key, child)) : limit + 1
      }
      const children = node.type === "sequence" ? node.steps
        : node.type === "parallel" ? node.branches
          : node.type === "foreach" || node.type === "repeat" ? [node.body]
            : node.type === "condition" ? [node.then, ...(node.else ? [node.else] : [])]
              : []
      let total = 1
      for (const child of children) {
        total = add(total, expansion(child))
        if (total > limit) return total
      }
      if (node.type === "foreach") total = add(1, multiply(total - 1, node.maxItems))
      if (node.type === "repeat") total = add(1, multiply(total - 1, node.maxIterations))
      return total
    }
    const expanded = expansion(rootDefinition.root)
    if (expanded > limit) throw new WorkflowRunError(`Saved workflow graph can expand above limit ${limit}`, 400)
    return { root: rootDefinition, saved: snapshots }
  }

  validateDefinition(source: string | unknown) { return validateWorkflowDefinition(source) }
  async createDefinition(source: string | unknown) {
    await this.ensureInitialized()
    return this.withAdmission(() => this.definitionStore.create(source))
  }
  async updateDefinition(id: string, expectedRevision: number, source: string | unknown) {
    await this.ensureInitialized()
    return this.withAdmission(() => this.definitionStore.update(id, expectedRevision, source))
  }
  async deleteDefinition(id: string, expectedRevision: number) {
    await this.ensureInitialized()
    return this.withAdmission(() => this.definitionStore.delete(id, expectedRevision))
  }
  async getDefinition(id: string, revision?: number) { return this.definitionStore.get(id, revision) }
  async listDefinitions(): Promise<WorkflowDefinitionRecord[]> { return this.definitionStore.list() }

  async get(runId: string, workspaceId?: string): Promise<WorkflowRun | undefined> {
    await this.ensureInitialized()
    let active = this.activeRuns.get(runId)
    if (!active) {
      await this.refreshForRead()
      active = this.activeRuns.get(runId)
    }
    if (!active) {
      const run = await this.read(runId)
      return workspaceId && run ? this.bindWorkspace(run.id, workspaceId) : run
    }
    if (["paused", "waiting_for_review", "waiting_for_input", "completed", "failed", "cancelled", "interrupted", "recovery_required"].includes(active.run.status)) {
      await active.completion
      if (active.releaseBlocked) return workspaceId ? this.bindWorkspace(active.run.id, workspaceId) : active.run
      const run = await this.read(runId) ?? active.run
      return workspaceId ? this.bindWorkspace(run.id, workspaceId) : run
    }
    return workspaceId ? this.bindWorkspace(active.run.id, workspaceId) : active.run
  }

  async list(workspaceId?: string): Promise<WorkflowRun[]> {
    await this.ensureInitialized()
    await this.refreshForRead()
    const requested = workspaceId ? this.options.workspaceManager.get(workspaceId) : undefined
    const candidates = Array.from(this.runIndex.values())
      .filter((entry) => !workspaceId || this.indexMatchesWorkspace(entry, workspaceId, requested))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const matched: WorkflowRun[] = []
    for (const entry of candidates) {
      if (matched.length >= WORKFLOW_HISTORY_LIMIT) break
      const run = await this.readForListing(`${entry.id}.json`)
      if (!run) continue
      const bound = workspaceId ? await this.bindWorkspace(run.id, workspaceId) : run
      if (bound) matched.push(bound)
    }
    return matched
  }

  /** Uncapped ownership predicate matching execution and source workspaces by ID, canonical lineage, or canonical path. */
  async isWorkspaceWorkflowOwned(identity: WorkflowWorkspaceIdentity): Promise<boolean> {
    await this.ensureInitialized()
    return this.withAdmission(() => this.isWorkspaceWorkflowOwnedCurrent(identity))
  }

  /** Holds the same serialized lease as workflow admission through the ownership decision and caller operation. */
  async withWorkspaceOwnershipLease<T>(
    identity: WorkflowWorkspaceIdentity,
    operation: (owned: boolean) => Promise<T>,
  ): Promise<T> {
    await this.ensureInitialized()
    return this.withAdmission(async () => operation(await this.isWorkspaceWorkflowOwnedCurrent(identity)))
  }

  /** Uncapped worktree predicate matching the source canonically and the selected worktree by slug or path. */
  async isWorktreeWorkflowOwned(source: WorkflowWorkspaceIdentity, worktree: WorkflowWorktreeIdentity): Promise<boolean> {
    await this.ensureInitialized()
    return this.withAdmission(() => this.isWorktreeWorkflowOwnedCurrent(source, worktree))
  }

  /** Holds workflow admission while a caller checks and deletes a canonical managed worktree. */
  async withWorktreeOwnershipLease<T>(
    source: WorkflowWorkspaceIdentity,
    worktree: WorkflowWorktreeIdentity,
    operation: (owned: boolean) => Promise<T>,
  ): Promise<T> {
    await this.ensureInitialized()
    return this.withAdmission(async () => operation(await this.isWorktreeWorkflowOwnedCurrent(source, worktree)))
  }

  async approve(runId: string, expectedStepId: string): Promise<WorkflowRun | undefined> {
    await this.ensureInitialized()
    this.throwIfShuttingDown()
    const candidate = this.activeRuns.get(runId)?.run ?? await this.read(runId)
    if (candidate?.definitionSnapshot) {
      if (candidate.pendingGate?.gate !== "approval") throw new WorkflowRunError("Workflow run is not waiting for approval", 409)
      if (candidate.pendingGate.executionNodeId !== expectedStepId) throw new WorkflowRunError("Workflow approval is stale", 409)
      return this.answer(runId, candidate.pendingGate.executionNodeId, true)
    }
    return this.withAdmission(() => this.withRunTransition(runId, async () => {
      this.throwIfShuttingDown()
      const current = this.activeRuns.get(runId)
      if (current?.run.status === "waiting_for_review") await current.completion
      else if (current) {
        throw new WorkflowRunError("Workflow stage is not ready for review", 409)
      }
      const run = await this.read(runId)
      if (!run) return undefined
      if (run.pendingReviewStepId !== expectedStepId) throw new WorkflowRunError("Workflow approval is stale", 409)
      const reviewed = run.steps.find((step) => step.id === run.pendingReviewStepId)
      if (run.status !== "waiting_for_review" || reviewed?.status !== "completed") {
        throw new WorkflowRunError("Workflow run is not waiting for review", 409)
      }

      const restoredWorkspace = this.options.workspaceManager.list().find((workspace) =>
        workspace.lineageId === run.workspaceLineageId && workspace.status === "ready")
      if (restoredWorkspace && restoredWorkspace.id !== run.workspaceId) {
        await this.bindWorkspaceCurrent(run, restoredWorkspace.id)
      }
      const workspace = this.options.workspaceManager.get(run.workspaceId)
      if (workspace) await this.assertNoPersistedReservation(workspace, run.id)
      const client = this.requireReadyClient(run.workspaceId, run.id)
      const prior = this.cloneRun(run)
      run.status = "running"
      delete run.pendingReviewStepId
      delete run.error
      this.claimExecutor(run)
      const active: ActiveRun = {
        run, client, activeSessionIds: new Set(), abortingSessions: new Map(), cancelRequested: false,
        abortController: new AbortController(), releaseBlocked: false, pauseCommitted: false,
        leaseFence: run.executorFence!, leaseLost: false, leaseDurablyReleased: false,
      }
      this.reserve(active)
      try {
        await this.persist(run)
      } catch (error) {
        this.restoreRun(run, prior)
        this.release(active)
        this.reserveRun(run)
        throw error
      }
      if (active.cancelRequested || this.shuttingDown) {
        return this.cancelRunCurrent(runId, run)
      }
      this.launch(active, (current) => this.executePendingStages(current))
      return run
    }))
  }

  async answer(runId: string, executionNodeId: string, answer: unknown): Promise<WorkflowRun | undefined> {
    await this.ensureInitialized()
    this.throwIfShuttingDown()
    return this.withAdmission(() => this.withRunTransition(runId, async () => {
      this.throwIfShuttingDown()
      const current = this.activeRuns.get(runId)
      if (current && (!current.run.pendingGate || !["waiting_for_review", "waiting_for_input"].includes(current.run.status))) {
        if (current.run.executionNodes?.some((node) => node.id === executionNodeId && node.status === "completed")) {
          throw new WorkflowRunError("Workflow gate answer is stale", 409)
        }
        throw new WorkflowRunError("Workflow run is not waiting for a gate answer", 409)
      }
      if (current?.completion) await current.completion
      const run = await this.read(runId)
      if (!run) return undefined
      const gate = run.pendingGate
      if (!run.definitionSnapshot || !gate || !["waiting_for_review", "waiting_for_input"].includes(run.status)) {
        throw new WorkflowRunError("Workflow run is not waiting for a gate answer", 409)
      }
      if (gate.executionNodeId !== executionNodeId) throw new WorkflowRunError("Workflow gate answer is stale", 409)
      if (gate.gate === "approval" && answer !== true) {
        throw new WorkflowRunError("Approval gates require answer true", 400)
      }
      if (gate.gate === "input" && gate.inputSchema) {
        const issues = validateJsonSchemaValue(answer, gate.inputSchema)
        if (issues.length) throw new WorkflowRunError(`Gate answer is invalid: ${issues.join("; ")}`, 400)
      }
      const serializedAnswer = JSON.stringify(answer)
      if (serializedAnswer === undefined || serializedAnswer.length > MAX_OUTPUT_CHARS) throw new WorkflowRunError("Gate answer is too large", 400)
      const execution = run.executionNodes?.find((node) => node.id === gate.executionNodeId)
      if (!execution || execution.status !== "waiting") throw new WorkflowRunError("Workflow gate state is invalid", 409)
      const client = await this.prepareDefinitionWorkspace(run)
      this.throwIfShuttingDown()
      const prior = this.cloneRun(run)
      await this.confirmPersistedSessionAborts(run, client, "Workflow gate answer")
      execution.status = "completed"
      execution.output = answer
      execution.completedAt = new Date().toISOString()
      delete run.pendingGate
      return this.resumeDefinitionRun(run, client, prior)
    }))
  }

  async pause(runId: string): Promise<WorkflowRun | undefined> {
    await this.ensureInitialized()
    this.throwIfShuttingDown()
    return this.withAdmission(() => this.withRunTransition(runId, async () => {
      const run = this.activeRuns.get(runId)?.run ?? await this.read(runId)
      if (!run) return undefined
      this.assertNoLiveForeignLease(run)
      if (!run.definitionSnapshot) throw new WorkflowRunError("Legacy workflows cannot be paused", 409)
      if (run.status === "paused" || run.status === "pausing") return run
      if (run.status !== "running") throw new WorkflowRunError("Workflow run is not running", 409)
      const priorStatus = run.status
      const priorPauseRequested = run.pauseRequested
      run.pauseRequested = true
      run.status = "pausing"
      try {
        await this.persist(run)
        const active = this.activeRuns.get(runId)
        if (active?.run === run) active.pauseCommitted = true
      } catch (error) {
        if (run.status === "pausing") run.status = priorStatus
        if (run.pauseRequested === true) {
          if (priorPauseRequested === undefined) delete run.pauseRequested
          else run.pauseRequested = priorPauseRequested
        }
        throw error
      }
      return run
    }))
  }

  async resume(runId: string, confirmRecovery = false, expectedRevision?: number): Promise<WorkflowRun | undefined> {
    await this.ensureInitialized()
    this.throwIfShuttingDown()
    return this.withAdmission(() => this.withRunTransition(runId, async () => {
      this.throwIfAdmissionBlocked()
      const active = this.activeRuns.get(runId)
      if (active && !["paused", "interrupted", "recovery_required"].includes(active.run.status)) {
        throw new WorkflowRunError("Workflow run cannot be resumed", 409)
      }
      if (active?.completion) await active.completion
      const run = await this.read(runId)
      if (!run) return undefined
      if (!run.definitionSnapshot) throw new WorkflowRunError("Legacy workflows cannot be resumed", 409)
      if (run.status === "recovery_required" && !confirmRecovery) {
        throw new WorkflowRunError("Recovery confirmation is required before repeating an ambiguous side effect", 409)
      }
      if (confirmRecovery && (run.status !== "recovery_required" || expectedRevision !== run.revision)) {
        throw new WorkflowRunError("Workflow recovery confirmation is stale", 409)
      }
      if (!["paused", "interrupted", "recovery_required"].includes(run.status)) {
        throw new WorkflowRunError("Workflow run cannot be resumed", 409)
      }
      const client = await this.prepareDefinitionWorkspace(run)
      this.throwIfShuttingDown()
      const prior = this.cloneRun(run)
      if (run.status === "recovery_required") {
        const sessionIds = this.persistedAmbiguousSessionIds(run)
        if (sessionIds.size === 0 && this.hasUnconfirmedAdmittedAction(run)) {
          const message = "Workflow recovery has no persisted session IDs and cannot positively confirm termination; the interrupted action will not be repeated"
          await this.persistMutation(run, () => markWorkflowRecoveryRequired(run, message))
          throw new WorkflowRunError(message, 409)
        }
        await this.confirmPersistedSessionAborts(run, client, "Workflow recovery")
        for (const node of run.executionNodes ?? []) if (node.status === "interrupted") {
          node.status = "pending"
          node.attempt = 0
          delete node.error
          delete node.completedAt
        }
      } else {
        await this.confirmPersistedSessionAborts(run, client, "Workflow resume")
      }
      if (active) {
        active.activeSessionIds.clear()
        active.activeSessionId = undefined
        active.releaseBlocked = false
        if (this.activeRuns.get(run.id) === active) this.activeRuns.delete(run.id)
      }
      return this.resumeDefinitionRun(run, client, prior)
    }))
  }

  async cancel(runId: string): Promise<WorkflowRun | undefined> {
    await this.ensureInitialized()
    if (this.shuttingDown) throw new WorkflowRunError("CodeNomad is shutting down", 503)
    return this.withAdmission(() => this.cancelRun(runId))
  }

  /** Atomically verifies plugin workspace ownership and cancels without joining/rebinding the run via get(). */
  async cancelOwned(runId: string, workspaceId: string): Promise<WorkflowRun | undefined> {
    await this.ensureInitialized()
    if (this.shuttingDown) throw new WorkflowRunError("CodeNomad is shutting down", 503)
    return this.withAdmission(() => this.withRunTransition(runId, async () => {
      const run = this.activeRuns.get(runId)?.run ?? await this.read(runId)
      if (!run) return undefined
      const workspace = this.options.workspaceManager.get(workspaceId)
      const executionMatch = run.workspaceId === workspaceId || Boolean(workspace?.status === "ready"
        && this.matchesCanonicalWorkspace(workspace, run.workspaceLineageId, run.workspacePath))
      const selection = run.worktreeSelection
      const sourceMatch = selection?.sourceWorkspaceId === workspaceId || Boolean(selection && workspace?.status === "ready"
        && this.matchesCanonicalWorkspace(workspace, selection.sourceWorkspaceLineageId, selection.sourceWorkspacePath))
      if (!executionMatch && !sourceMatch) return undefined
      if (executionMatch && run.workspaceId !== workspaceId) {
        if (!await this.bindWorkspaceCurrent(run, workspaceId)) return undefined
      }
      return this.cancelRunCurrent(runId, run)
    }))
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shuttingDown = true
      this.shutdownAbortController.abort(new WorkflowCancelledError())
      this.shutdownPromise = this.performShutdown()
    }
    const pending = this.shutdownPromise
    try {
      await this.withTimeout(pending, SHUTDOWN_TIMEOUT_MS, "Workflow shutdown timed out")
    } catch (error) {
      if (this.shutdownPromise === pending) this.shutdownPromise = undefined
      throw error
    }
  }

  private async cancelRun(runId: string): Promise<WorkflowRun | undefined> {
    return this.withRunTransition(runId, async () => {
      const run = this.activeRuns.get(runId)?.run ?? await this.read(runId)
      if (!run) return undefined
      return this.cancelRunCurrent(runId, run)
    })
  }

  private async cancelRunCurrent(runId: string, run: WorkflowRun): Promise<WorkflowRun> {
    const active = this.activeRuns.get(runId)
    this.assertNoLiveForeignLease(run)
    if (!["running", "pausing", "paused", "waiting_for_review", "waiting_for_input", "interrupted", "recovery_required"].includes(run.status)) return run

    let terminationConfirmed = true
    if (active) {
      this.requestCancellation(active)
      await this.drainSessions(active)
      await active.completion
      terminationConfirmed = await this.drainSessions(active)
      if (terminationConfirmed) this.clearPersistedSessions(run, this.persistedAmbiguousSessionIds(run))
    }
    const sessionIds = this.persistedAmbiguousSessionIds(run)
    if (sessionIds.size > 0) {
      const client = active?.client ?? await this.prepareDefinitionWorkspace(run)
      terminationConfirmed = terminationConfirmed && (await Promise.all(Array.from(sessionIds).map((sessionId) =>
        this.abortSessionRequest(client, run.id, sessionId)))).every(Boolean)
    } else if (run.status === "recovery_required" && !active) {
      terminationConfirmed = !this.hasUnconfirmedAdmittedAction(run)
    }
    const message = sessionIds.size === 0
      ? "Workflow cancellation has no persisted session IDs and cannot positively confirm termination"
      : "Workflow cancellation could not confirm every session abort"
    try {
      await this.persistMutation(run, () => {
        if (terminationConfirmed) {
          this.clearPersistedSessions(run, sessionIds)
          this.markCancelled(run)
          this.clearExpiredExecutorLease(run)
          this.releaseExecutorLease(run)
        } else {
          markWorkflowRecoveryRequired(run, message)
          this.clearExpiredExecutorLease(run)
          this.releaseExecutorLease(run)
        }
      })
      if (terminationConfirmed) await durableRemove(this.recoveryMarkerPath(run.id)).catch((error) => {
        this.options.logger.warn({ err: error, runId: run.id }, "Failed to clear resolved workflow recovery marker")
      })
    } catch (error) {
      if (active) active.releaseBlocked = true
      this.reserveRun(run)
      throw error
    }
    if (active) {
      active.releaseBlocked = !terminationConfirmed
      if (terminationConfirmed) this.release(active)
    }
    if (!holdsWorkflowReservation(run) && this.activeWorkspaces.get(run.workspaceId) === run.id) {
      this.activeWorkspaces.delete(run.workspaceId)
    }
    if (!holdsWorkflowReservation(run) && this.reservedLineages.get(run.workspaceLineageId) === run.id) {
      this.reservedLineages.delete(run.workspaceLineageId)
    }
    if (!holdsWorkflowReservation(run) && this.reservedPaths.get(this.pathKey(run.workspacePath)) === run.id) {
      this.reservedPaths.delete(this.pathKey(run.workspacePath))
    }
    return run
  }

  private async performShutdown(): Promise<void> {
    await this.ensureInitialized()
    await this.admissionQueue.catch(() => undefined)
    await this.drainCreationCleanups(true)
    const active = Array.from(this.activeRuns.values())
    for (const run of active) this.requestCancellation(run)
    await Promise.all(active.map(async (item) => {
      try {
        await this.cancelRun(item.run.id)
      } catch (error) {
        if (!(error instanceof WorkflowRunError) || error.statusCode !== 409) throw error
        this.release(item, true)
      }
    }))
    await Promise.all(active.map(({ completion }) => completion))
    await Promise.all(Array.from(this.transitionQueues.values()))
    await Promise.all(Array.from(this.persistQueues.values()))
  }

  private async resumeDefinitionRun(run: WorkflowRun, client: OpencodeClient, prior = this.cloneRun(run)): Promise<WorkflowRun> {
    this.throwIfShuttingDown()
    run.status = "running"
    run.pauseRequested = false
    delete run.error
    this.claimExecutor(run)
    const active: ActiveRun = {
      run,
      client,
      activeSessionIds: new Set(),
      abortingSessions: new Map(),
      cancelRequested: false,
      abortController: new AbortController(),
      releaseBlocked: false,
      pauseCommitted: false,
      leaseFence: run.executorFence!,
      leaseLost: false,
      leaseDurablyReleased: false,
    }
    this.reserve(active)
    try {
      await this.persist(run)
      await durableRemove(this.recoveryMarkerPath(run.id)).catch((error) => {
        this.options.logger.warn({ err: error, runId: run.id }, "Failed to clear resolved workflow recovery marker")
      })
    } catch (error) {
      this.restoreRun(run, prior)
      active.releaseBlocked = false
      this.release(active)
      this.reserveRun(run)
      throw error
    }
    this.launch(active, (current) => this.executeDefinition(current))
    return run
  }

  private async prepareDefinitionWorkspace(run: WorkflowRun): Promise<OpencodeClient> {
    this.throwIfShuttingDown()
    const lineageWorkspace = this.options.workspaceManager.list().find((workspace) =>
      workspace.status === "ready" && this.matchesCanonicalWorkspace(workspace, run.workspaceLineageId, run.workspacePath))
    if (lineageWorkspace && lineageWorkspace.id !== run.workspaceId) {
      this.throwIfShuttingDown()
      await this.bindWorkspaceCurrent(run, lineageWorkspace.id)
    }
    this.throwIfShuttingDown()
    const workspace = this.options.workspaceManager.get(run.workspaceId)
    if (workspace) await this.assertNoPersistedReservation(workspace, run.id)
    return this.requireReadyClient(run.workspaceId, run.id)
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
    this.throwIfAdmissionBlocked()
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
    const pathRunId = this.reservedPaths.get(this.pathKey(workspace.path))
    if (pathRunId && pathRunId !== runId) {
      throw new WorkflowRunError("A workflow is already running for this workspace path", 409)
    }
    const client = this.createClient(workspaceId)
    if (!client) throw new WorkflowRunError("Workspace instance is not ready", 409)
    return client
  }

  private async assertNoPersistedReservation(workspace: WorkspaceDescriptor, runId?: string): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.options.storageDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === `${runId}.json`) continue
      const persistedId = entry.slice(0, -5)
      let run: WorkflowRun
      try {
        run = JSON.parse(await fs.readFile(path.join(this.options.storageDir, entry), "utf8")) as WorkflowRun
        validatePersistedWorkflowRun(run, persistedId)
      } catch (error) {
        this.options.logger.warn({ err: error, file: entry }, "Skipping corrupt workflow run during admission")
        continue
      }
      if (!holdsWorkflowReservation(run)) continue
      if (run.workspaceLineageId === (workspace.lineageId ?? workspace.id)) {
        throw new WorkflowRunError("A workflow is already running for this workspace lineage", 409)
      }
      if (this.samePath(run.workspacePath, workspace.path)) {
        throw new WorkflowRunError("A workflow is already running for this workspace path", 409)
      }
    }
  }

  private throwIfShuttingDown(): void {
    if (this.shuttingDown) throw new WorkflowRunError("CodeNomad is shutting down", 503)
  }

  private throwIfAdmissionBlocked(): void {
    if (this.admissionFailure) throw new WorkflowRunError(this.admissionFailure, 503)
  }

  private requestCancellation(active: ActiveRun): void {
    active.releaseBlocked = true
    active.cancelRequested = true
    active.abortController.abort(new WorkflowCancelledError("Workflow run cancelled"))
  }

  private async drainSessions(active: ActiveRun): Promise<boolean> {
    const sessionIds = new Set(active.activeSessionIds)
    if (active.activeSessionId) sessionIds.add(active.activeSessionId)
    const results = await Promise.all(Array.from(sessionIds).map((sessionId) => this.abortActiveSession(active, sessionId)))
    return results.every(Boolean) && active.activeSessionIds.size === 0 && active.activeSessionId === undefined
  }

  private reserve(active: ActiveRun) {
    this.activeRuns.set(active.run.id, active)
    // ponytail: one run per workspace; add worktree-aware concurrency only when parallel workflows are needed.
    this.reserveRun(active.run)
  }

  private reserveRun(run: WorkflowRun) {
    this.activeWorkspaces.set(run.workspaceId, run.id)
    this.reservedLineages.set(run.workspaceLineageId, run.id)
    this.reservedPaths.set(this.pathKey(run.workspacePath), run.id)
  }

  private release(active: ActiveRun, force = false) {
    if (this.activeRuns.get(active.run.id) !== active) return
    if (!force && active.run.definitionSnapshot && this.persistedAmbiguousSessionIds(active.run).size > 0) active.releaseBlocked = true
    if (active.releaseBlocked && !force) {
      this.options.logger.error({ runId: active.run.id }, "Retaining workflow reservation after unconfirmed session abort")
      return
    }
    if (active.heartbeat) clearTimeout(active.heartbeat)
    this.activeRuns.delete(active.run.id)
    if ((force || !holdsWorkflowReservation(active.run)) && this.activeWorkspaces.get(active.run.workspaceId) === active.run.id) {
      this.activeWorkspaces.delete(active.run.workspaceId)
    }
    if ((force || !holdsWorkflowReservation(active.run)) && this.reservedLineages.get(active.run.workspaceLineageId) === active.run.id) {
      this.reservedLineages.delete(active.run.workspaceLineageId)
    }
    const pathKey = this.pathKey(active.run.workspacePath)
    if ((force || !holdsWorkflowReservation(active.run)) && this.reservedPaths.get(pathKey) === active.run.id) {
      this.reservedPaths.delete(pathKey)
    }
  }

  private withAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const admitted = this.admissionQueue.catch(() => undefined)
      .then(() => withFilesystemLock(this.admissionLockPath(), async () => {
        await this.refreshRunIndex()
        await this.recoverInterruptedRuns()
        return operation()
      }))
    this.admissionQueue = admitted.then(() => undefined, () => undefined)
    return admitted
  }

  private refreshForRead(): Promise<void> {
    if (this.readRefresh) return this.readRefresh
    if (Date.now() - this.lastReadRefreshAt < READ_REFRESH_MS) return Promise.resolve()
    const refresh = this.withAdmission(async () => undefined)
      .then(() => { this.lastReadRefreshAt = Date.now() })
      .finally(() => { if (this.readRefresh === refresh) this.readRefresh = undefined })
    this.readRefresh = refresh
    return refresh
  }

  private admissionLockPath(): string {
    return path.join(this.options.storageDir, ".admission.lock")
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      const pending = withFilesystemLock(this.admissionLockPath(), () => this.recoverInterruptedRuns())
      const attempt = pending.catch((error) => {
        if (this.initialized === attempt) this.initialized = undefined
        throw error
      })
      this.initialized = attempt
    }
    return this.initialized
  }

  private claimExecutor(run: WorkflowRun): void {
    this.assertNoLiveForeignLease(run)
    const fence = (run.executorFence ?? 0) + 1
    const heartbeatAt = new Date().toISOString()
    run.executorFence = fence
    run.executorLease = {
      ownerToken: this.managerToken, fence, heartbeatAt, expiresAt: this.executorLeaseExpiry(heartbeatAt),
      hostname: this.processOwner.hostname, pid: this.processOwner.pid,
      ...(this.processOwner.processStart ? { processStart: this.processOwner.processStart } : {}),
      ...(this.processOwner.bootId ? { bootId: this.processOwner.bootId } : {}),
    }
  }

  private releaseExecutorLease(run: WorkflowRun): void {
    if (run.executorLease?.ownerToken !== this.managerToken) return
    delete run.executorLease
    const active = this.activeRuns.get(run.id)
    if (active?.heartbeat) {
      clearTimeout(active.heartbeat)
      active.heartbeat = undefined
    }
  }

  private clearExpiredExecutorLease(run: WorkflowRun): void {
    if (run.executorLease && !this.isLeaseLive(run)) delete run.executorLease
  }

  private assertNoLiveForeignLease(run: WorkflowRun): void {
    const lease = run.executorLease
    if (lease && lease.ownerToken !== this.managerToken && this.isLeaseLive(run)) {
      throw new WorkflowRunError("Workflow run is executing on another CodeNomad host", 409)
    }
  }

  private isLeaseLive(run: WorkflowRun): boolean {
    const lease = run.executorLease
    if (!lease) return false
    if (!lease.hostname || !lease.pid) return Date.parse(lease.expiresAt) > Date.now()
    if (lease.hostname !== this.processOwner.hostname) return true
    if (lease.pid === this.processOwner.pid) {
      return !lease.processStart || !this.processOwner.processStart
        || (lease.processStart === this.processOwner.processStart && (!lease.bootId || lease.bootId === this.processOwner.bootId))
    }
    const liveness = executorProcessLiveness(lease.pid, lease.processStart, lease.bootId)
    return liveness === "alive" || liveness === "unknown"
  }

  private executorLeaseExpiry(heartbeatAt = new Date().toISOString()): string {
    return new Date(Date.parse(heartbeatAt) + EXECUTOR_LEASE_MS).toISOString()
  }

  private deferCreationCleanup(requestId: string): void {
    if (!this.deferredCreationCleanups.has(requestId)) this.deferredCreationCleanups.set(requestId, 0)
  }

  private async drainCreationCleanups(retryUntilExhausted = false): Promise<void> {
    const pending = this.creationCleanupQueue.catch(() => undefined).then(async () => {
      const passes = retryUntilExhausted ? CREATION_CLEANUP_ATTEMPTS : 1
      for (let pass = 0; pass < passes; pass += 1) {
        const cleanups = Array.from(this.deferredCreationCleanups)
        if (cleanups.length === 0) return
        for (const [requestId, attempts] of cleanups) {
          try {
            await this.options.workspaceManager.cancelCreationRequest(requestId)
            this.deferredCreationCleanups.delete(requestId)
          } catch (error) {
            const nextAttempts = attempts + 1
            this.deferredCreationCleanups.set(requestId, nextAttempts)
            this.options.logger.warn(
              { err: error, requestId, attempt: nextAttempts },
              nextAttempts >= CREATION_CLEANUP_ATTEMPTS
                ? "Workflow workspace creation cleanup remains deferred after repeated failures"
                : "Workflow workspace creation cleanup will be retried",
            )
          }
        }
        if (!retryUntilExhausted) return
      }
      if (this.deferredCreationCleanups.size > 0) {
        throw new Error(`Workflow workspace creation cleanup remains pending for ${this.deferredCreationCleanups.size} request(s)`)
      }
    })
    this.creationCleanupQueue = pending.then(() => undefined, () => undefined)
    await pending
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
    this.scheduleExecutorHeartbeat(active)
    active.completion = execute(active)
      .catch((error) => this.handleExecutionError(active, error))
      .catch(async (error) => {
        const message = `Workflow recovery is required because terminal state could not be persisted: ${this.errorMessage(error)}`
        const blockedMessage = `Workflow admission is blocked because recovery state could not be recorded for run ${active.run.id}; repair storage and restart CodeNomad`
        markWorkflowRecoveryRequired(active.run, message)
        active.releaseBlocked = true
        this.reserveRun(active.run)
        if (!this.admissionFailure) this.admissionFailure = blockedMessage
        await this.abandonExecutorLease(active).then(() => this.writeRecoveryMarker(active.run, message)).then(() => {
          if (this.admissionFailure === blockedMessage) this.admissionFailure = undefined
        }).catch((markerError) => {
          this.options.logger.error({ err: markerError, runId: active.run.id }, "Failed to write workflow recovery marker")
        })
        this.options.logger.error({ err: error, runId: active.run.id }, "Failed to persist workflow failure")
      })
      .finally(() => this.release(active))
  }

  private scheduleExecutorHeartbeat(active: ActiveRun): void {
    active.heartbeat = setTimeout(() => {
      void this.renewExecutorLease(active).then(() => {
        if (active.run.executorLease?.ownerToken === this.managerToken
          && active.run.executorLease.fence === active.leaseFence) this.scheduleExecutorHeartbeat(active)
      }).catch((error) => {
        if (active.run.executorLease?.ownerToken !== this.managerToken
          || active.run.executorLease.fence !== active.leaseFence) return
        active.leaseLost = true
        active.releaseBlocked = true
        active.cancelRequested = true
        active.abortController.abort(new WorkflowCancelledError("Workflow executor lease was lost"))
        void this.drainSessions(active)
        this.options.logger.error({ err: error, runId: active.run.id }, "Workflow executor lease heartbeat failed")
      })
    }, EXECUTOR_HEARTBEAT_MS)
    active.heartbeat.unref()
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
        this.releaseExecutorLease(run)
        await this.persist(run)
        return
      }
    }

    run.status = "completed"
    delete run.activeStepId
    delete run.pendingReviewStepId
    this.releaseExecutorLease(run)
    await this.persist(run)
  }

  private cloneRun(run: WorkflowRun): WorkflowRun {
    return JSON.parse(JSON.stringify(run)) as WorkflowRun
  }

  private restoreRun(run: WorkflowRun, snapshot: WorkflowRun): void {
    const currentNodes = run.executionNodes
    const restored = this.cloneRun(snapshot)
    for (const key of Object.keys(run) as Array<keyof WorkflowRun>) delete run[key]
    Object.assign(run, restored)
    if (!currentNodes || !restored.executionNodes) return
    const byId = new Map(currentNodes.map((node) => [node.id, node]))
    const nodes = restored.executionNodes.map((snapshotNode) => {
      const current = byId.get(snapshotNode.id)
      if (!current) return snapshotNode
      for (const key of Object.keys(current) as Array<keyof typeof current>) delete current[key]
      Object.assign(current, snapshotNode)
      return current
    })
    currentNodes.splice(0, currentNodes.length, ...nodes)
    run.executionNodes = currentNodes
  }

  private async persistMutation(run: WorkflowRun, mutate: () => void): Promise<void> {
    const prior = this.cloneRun(run)
    mutate()
    try {
      await this.persist(run)
    } catch (error) {
      this.restoreRun(run, prior)
      throw error
    }
  }

  private async executeDefinition(active: ActiveRun): Promise<void> {
    const interpreter = new WorkflowInterpreter({
      run: active.run,
      client: active.client,
      persist: () => this.persist(active.run),
      signal: (timeoutMs) => AbortSignal.any([active.abortController.signal, AbortSignal.timeout(timeoutMs)]),
      sessionStarted: (sessionId) => {
        active.activeSessionIds.add(sessionId)
        return !active.cancelRequested
      },
      sessionFinished: (sessionId) => active.activeSessionIds.delete(sessionId),
      abortSession: async (sessionId) => {
        const confirmed = await this.abortActiveSession(active, sessionId)
        if (!confirmed) active.releaseBlocked = true
        return confirmed
      },
      isCancelled: () => active.cancelRequested,
      revalidateFence: () => this.revalidateExecutorFence(active),
      isPauseCommitted: () => active.pauseCommitted,
    })
    try {
      await interpreter.execute()
    } catch (error) {
      if (error instanceof WorkflowSuspendedError) {
        if (active.pauseCommitted && active.run.pauseRequested) {
          const priorStatus = active.run.status
          active.run.status = "paused"
          this.releaseExecutorLease(active.run)
          try {
            await this.persist(active.run)
          } catch (persistError) {
            if (active.run.status === "paused") active.run.status = priorStatus
            throw persistError
          }
        } else {
          this.releaseExecutorLease(active.run)
          await this.persist(active.run)
        }
        return
      }
      throw error
    }
    this.throwIfCancelled(active)
    active.run.status = "completed"
    active.run.pauseRequested = false
    delete active.run.pendingGate
    this.releaseExecutorLease(active.run)
    try {
      await this.persist(active.run)
    } catch (error) {
      throw new WorkflowCheckpointError(`Workflow completed, but its terminal checkpoint could not be persisted: ${this.errorMessage(error)}`)
    }
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
    await this.revalidateExecutorFence(active)
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
    return bounded.output
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

  private async abortSessionRequest(client: OpencodeClient, runId: string, sessionId: string): Promise<boolean> {
    try {
      const response = await client.session.abort(
        { sessionID: sessionId },
        { signal: AbortSignal.timeout(ABORT_TIMEOUT_MS) },
      )
      if (response.data === true && response.error === undefined) return true
      this.options.logger.warn({ err: response.error, runId }, "Workflow session abort was not confirmed")
      return false
    } catch (error) {
      this.options.logger.warn({ err: error, runId }, "Failed to abort workflow session")
      return false
    }
  }

  private async abortActiveSession(active: ActiveRun, sessionId: string): Promise<boolean> {
    const existing = active.abortingSessions.get(sessionId)
    if (existing) return existing
    if (!active.activeSessionIds.has(sessionId) && active.activeSessionId !== sessionId) return true
    const pending = this.abortSessionRequest(active.client, active.run.id, sessionId).then((confirmed) => {
      if (confirmed) {
        active.activeSessionIds.delete(sessionId)
        if (active.activeSessionId === sessionId) active.activeSessionId = undefined
      }
      return confirmed
    }).finally(() => active.abortingSessions.delete(sessionId))
    active.abortingSessions.set(sessionId, pending)
    return pending
  }

  private async handleExecutionError(active: ActiveRun, error: unknown): Promise<void> {
    const { run } = active
    if (error instanceof WorkflowCheckpointError) {
      markWorkflowRecoveryRequired(run, this.errorMessage(error))
      this.releaseExecutorLease(run)
      await this.persist(run)
      return
    }
    if (active.activeSessionId) {
      const sessionId = active.activeSessionId
      if (!await this.abortActiveSession(active, sessionId)) active.releaseBlocked = true
    }
    if (run.definitionSnapshot && !await this.drainSessions(active)) active.releaseBlocked = true
    if (active.cancelRequested) return
    if (active.releaseBlocked) {
      const message = `Workflow session abort was not confirmed: ${this.errorMessage(error)}`
      markWorkflowRecoveryRequired(run, message)
      this.releaseExecutorLease(run)
      const step = run.steps.find((candidate) => candidate.status === "running")
      if (step) {
        step.status = "failed"
        step.error = message
        step.completedAt = new Date().toISOString()
      }
      await this.persist(run)
      return
    }
    if (active.cancelRequested || error instanceof WorkflowCancelledError) {
      this.markCancelled(run)
      this.releaseExecutorLease(run)
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
      for (const node of run.executionNodes ?? []) {
        if (node.status !== "running" && node.status !== "waiting") continue
        node.status = "failed"
        node.error = message
        node.completedAt = new Date().toISOString()
      }
      delete run.pendingGate
      delete run.activeStepId
      this.releaseExecutorLease(run)
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
    for (const node of run.executionNodes ?? []) {
      if (node.status !== "running" && node.status !== "waiting") continue
      node.status = "cancelled"
      node.completedAt = new Date().toISOString()
    }
    run.pauseRequested = false
    delete run.pendingGate
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

  private runMetadataPath(runId: string) {
    return path.join(this.options.storageDir, `${runId}.meta`)
  }

  private recoveryMarkerPath(runId: string) {
    return path.join(this.options.storageDir, `${runId}.recovery`)
  }

  private runLockPath(runId: string) {
    return path.join(this.options.storageDir, ".run-locks", `${runId}.lock`)
  }

  private async writeRecoveryMarker(run: WorkflowRun, message: string): Promise<void> {
    await ensureDurableDirectory(this.options.storageDir)
    await durableAtomicWrite(
      this.recoveryMarkerPath(run.id),
      JSON.stringify({ runId: run.id, revision: run.revision ?? 0, message, createdAt: new Date().toISOString() }),
    )
  }

  private async readRecoveryMarker(runId: string): Promise<{ revision?: number } | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.recoveryMarkerPath(runId), "utf8")) as { revision?: unknown }
      return Number.isInteger(parsed.revision) && (parsed.revision as number) >= 0
        ? { revision: parsed.revision as number }
        : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      return {}
    }
  }

  private async bindWorkspace(runId: string, workspaceId: string): Promise<WorkflowRun | undefined> {
    return this.withRunTransition(runId, async () => {
      const run = this.activeRuns.get(runId)?.run ?? await this.read(runId)
      return run ? this.bindWorkspaceCurrent(run, workspaceId) : undefined
    })
  }

  private async bindWorkspaceCurrent(run: WorkflowRun, workspaceId: string): Promise<WorkflowRun | undefined> {
    const requested = this.options.workspaceManager.get(workspaceId)
    const selection = run.worktreeSelection
    if (run.workspaceId === workspaceId) {
      if (selection?.policy.mode === "current" && selection.sourceWorkspaceId !== workspaceId) {
        const prior = this.cloneRun(run)
        selection.sourceWorkspaceId = workspaceId
        try {
          await this.persist(run, false)
        } catch (error) {
          this.restoreRun(run, prior)
          throw error
        }
      }
      return run
    }
    if (selection && selection.policy.mode !== "current" && requested
      && requested.status === "ready"
      && (selection.sourceWorkspaceId === workspaceId || (
        requested.lineageId === selection.sourceWorkspaceLineageId
        && this.samePath(requested.path, selection.sourceWorkspacePath)
      ))) {
      if (selection.sourceWorkspaceId !== workspaceId) {
        const prior = this.cloneRun(run)
        selection.sourceWorkspaceId = workspaceId
        try {
          await this.persist(run, false)
        } catch (error) {
          this.restoreRun(run, prior)
          throw error
        }
      }
      return run
    }
    if (["running", "pausing"].includes(run.status)) return undefined
    const workspace = requested
    if (!workspace || !workspace.lineageId || run.workspaceLineageId !== workspace.lineageId) return undefined
    if (!this.samePath(workspace.path, run.workspacePath)) return undefined
    const prior = this.cloneRun(run)
    const previousId = run.workspaceId
    run.workspaceId = workspaceId
    if (selection) {
      selection.workspaceId = workspaceId
      selection.directory = workspace.path
      if (selection.policy.mode === "current") selection.sourceWorkspaceId = workspaceId
    }
    run.workspacePath = workspace.path
    try {
      await this.persist(run, false)
    } catch (error) {
      this.restoreRun(run, prior)
      throw error
    }
    if (this.activeWorkspaces.get(previousId) === run.id) this.activeWorkspaces.delete(previousId)
    if (holdsWorkflowReservation(run)) this.activeWorkspaces.set(workspaceId, run.id)
    return run
  }

  private samePath(left: string, right: string): boolean {
    const normalizedLeft = path.resolve(left)
    const normalizedRight = path.resolve(right)
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight
  }

  private pathKey(value: string): string {
    const resolved = path.resolve(value)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }

  private matchesCanonicalWorkspace(workspace: WorkspaceDescriptor, lineageId: string, workspacePath: string): boolean {
    return workspace.lineageId === lineageId && this.samePath(workspace.path, workspacePath)
  }

  private matchesIdentity(identity: WorkflowWorkspaceIdentity, id: string, lineageId: string, workspacePath: string): boolean {
    return Boolean(
      (identity.id && identity.id === id)
      || (identity.lineageId && identity.lineageId === lineageId)
      || (identity.path && this.samePath(identity.path, workspacePath)),
    )
  }

  private async isWorkspaceWorkflowOwnedCurrent(identity: WorkflowWorkspaceIdentity): Promise<boolean> {
    if (this.admissionFailure) return true
    if (identity.lineageId && this.reservedLineages.has(identity.lineageId)) return true
    if (identity.path && this.reservedPaths.has(this.pathKey(identity.path))) return true
    return Array.from(this.runIndex.values()).some((run) => {
      if (!this.indexHoldsReservation(run)) return false
      if (this.matchesIdentity(identity, run.workspaceId, run.workspaceLineageId, run.workspacePath)) return true
      return Boolean(run.sourceWorkspaceId && run.sourceWorkspaceLineageId && run.sourceWorkspacePath && this.matchesIdentity(
        identity,
        run.sourceWorkspaceId,
        run.sourceWorkspaceLineageId,
        run.sourceWorkspacePath,
      ))
    })
  }

  private async isWorktreeWorkflowOwnedCurrent(
    source: WorkflowWorkspaceIdentity,
    worktree: WorkflowWorktreeIdentity,
  ): Promise<boolean> {
    if (this.admissionFailure) return true
    if (this.quarantinedWorktrees.some((run) => {
      if (worktree.path && run.worktreeDirectory && this.samePath(run.worktreeDirectory, worktree.path)) return true
      if (!worktree.slug || run.worktreeSlug !== worktree.slug) return false
      return Boolean(
        (source.id && run.sourceWorkspaceId === source.id)
        || (source.lineageId && run.sourceWorkspaceLineageId === source.lineageId)
        || (source.path && run.sourceWorkspacePath && this.samePath(run.sourceWorkspacePath, source.path)),
      )
    })) return true
    return Array.from(this.runIndex.values()).some((run) => {
      if (!this.indexHoldsReservation(run) || !run.worktreeDirectory) return false
      if (worktree.path && this.samePath(run.worktreeDirectory, worktree.path)) return true
      if (!run.sourceWorkspaceId || !run.sourceWorkspaceLineageId || !run.sourceWorkspacePath || !this.matchesIdentity(
        source,
        run.sourceWorkspaceId,
        run.sourceWorkspaceLineageId,
        run.sourceWorkspacePath,
      )) return false
      return Boolean(worktree.slug && run.worktreeSlug === worktree.slug)
    })
  }

  private persistedAmbiguousSessionIds(run: WorkflowRun): Set<string> {
    if (run.definitionSnapshot) return new Set((run.executionNodes ?? [])
      .filter((node) => !["completed", "skipped", "failed", "cancelled"].includes(node.status))
      .flatMap((node) => node.sessionIds ?? []))
    return new Set(run.steps
      .filter((step) => step.sessionId && (step.status === "running" || step.status === "failed"))
      .map((step) => step.sessionId!))
  }

  private hasUnconfirmedAdmittedAction(run: WorkflowRun): boolean {
    if (!run.definitionSnapshot) return run.steps.some((step) => step.status === "running")
    return Boolean(run.executionNodes?.some((node) =>
      (node.type === "agent" || node.type === "shell")
      && node.attempt > 0
      && !["completed", "skipped", "failed", "cancelled"].includes(node.status)))
  }

  private clearPersistedSessions(run: WorkflowRun, sessionIds: Set<string>): void {
    for (const node of run.executionNodes ?? []) {
      if (!node.sessionIds) continue
      node.sessionIds = node.sessionIds.filter((sessionId) => !sessionIds.has(sessionId))
      if (node.sessionIds.length === 0) delete node.sessionIds
    }
    for (const step of run.steps) if (step.sessionId && sessionIds.has(step.sessionId)) delete step.sessionId
    if (run.sessionBindings) {
      for (const [key, sessionId] of Object.entries(run.sessionBindings)) {
        if (sessionIds.has(sessionId)) delete run.sessionBindings[key]
      }
      if (Object.keys(run.sessionBindings).length === 0) delete run.sessionBindings
    }
  }

  private async confirmPersistedSessionAborts(run: WorkflowRun, client: OpencodeClient, action: string): Promise<void> {
    const sessionIds = this.persistedAmbiguousSessionIds(run)
    if (sessionIds.size === 0) return
    const confirmed = await Promise.all(Array.from(sessionIds).map((sessionId) =>
      this.abortSessionRequest(client, run.id, sessionId)))
    if (confirmed.some((result) => !result)) {
      const message = `${action} could not confirm every persisted session abort`
      await this.persistMutation(run, () => markWorkflowRecoveryRequired(run, message))
      throw new WorkflowRunError(message, 409)
    }
    this.clearPersistedSessions(run, sessionIds)
  }

  private async read(runId: string): Promise<WorkflowRun | undefined> {
    try {
      const run = JSON.parse(await fs.readFile(this.runPath(runId), "utf8")) as WorkflowRun
      validatePersistedWorkflowRun(run, runId)
      this.indexRun(run)
      return run
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  private async readStoredRun(runId: string): Promise<WorkflowRun | undefined> {
    try {
      const run = JSON.parse(await fs.readFile(this.runPath(runId), "utf8")) as WorkflowRun
      validatePersistedWorkflowRun(run, runId)
      return run
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  private async readForListing(entry: string): Promise<WorkflowRun | undefined> {
    try {
      return await this.read(entry.slice(0, -5))
    } catch (error) {
      this.options.logger.warn({ err: error, file: entry }, "Skipping corrupt workflow run")
      return undefined
    }
  }

  private runIndexEntry(run: WorkflowRun): RunIndexEntry {
    const selection = run.worktreeSelection
    return {
      id: run.id,
      workspaceId: run.workspaceId,
      workspaceLineageId: run.workspaceLineageId,
      workspacePath: run.workspacePath,
      ...(selection ? {
        sourceWorkspaceId: selection.sourceWorkspaceId,
        sourceWorkspaceLineageId: selection.sourceWorkspaceLineageId,
        sourceWorkspacePath: selection.sourceWorkspacePath,
        worktreeDirectory: selection.directory,
        ...(selection.slug ? { worktreeSlug: selection.slug } : {}),
      } : {}),
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ambiguousSessions: Boolean(run.definitionSnapshot && this.persistedAmbiguousSessionIds(run).size > 0),
    }
  }

  private indexRun(run: WorkflowRun): void {
    this.runIndex.set(run.id, this.runIndexEntry(run))
  }

  private async readRunMetadata(entry: string): Promise<RunFileMetadata | undefined> {
    const runId = entry.slice(0, -5)
    try {
      const [stored, stat] = await Promise.all([
        fs.readFile(this.runMetadataPath(runId), "utf8"),
        fs.stat(path.join(this.options.storageDir, entry)),
      ])
      const metadata = JSON.parse(stored) as RunFileMetadata
      if (metadata.id !== runId || metadata.size !== stat.size || metadata.mtimeMs !== stat.mtimeMs
        || typeof metadata.workspaceId !== "string" || typeof metadata.workspaceLineageId !== "string"
        || typeof metadata.workspacePath !== "string" || typeof metadata.createdAt !== "string"
        || typeof metadata.updatedAt !== "string" || typeof metadata.ambiguousSessions !== "boolean"
        || !["running", "pausing", "paused", "waiting_for_review", "waiting_for_input", "completed", "failed", "cancelled", "interrupted", "recovery_required"]
          .includes(metadata.status)) return undefined
      return metadata
    } catch {
      return undefined
    }
  }

  private async writeRunMetadata(run: WorkflowRun): Promise<void> {
    const stat = await fs.stat(this.runPath(run.id))
    const metadata: RunFileMetadata = { ...this.runIndexEntry(run), size: stat.size, mtimeMs: stat.mtimeMs }
    const destination = this.runMetadataPath(run.id)
    const temporary = `${destination}.${randomUUID()}.tmp`
    await fs.writeFile(temporary, JSON.stringify(metadata), "utf8")
    await fs.rename(temporary, destination)
  }

  private indexMatchesWorkspace(entry: RunIndexEntry, workspaceId: string, workspace?: WorkspaceDescriptor): boolean {
    if (entry.workspaceId === workspaceId || entry.sourceWorkspaceId === workspaceId) return true
    if (!workspace?.lineageId) return false
    return this.matchesCanonicalWorkspace(workspace, entry.workspaceLineageId, entry.workspacePath)
      || Boolean(entry.sourceWorkspaceLineageId && entry.sourceWorkspacePath
        && this.matchesCanonicalWorkspace(workspace, entry.sourceWorkspaceLineageId, entry.sourceWorkspacePath))
  }

  private indexHoldsReservation(entry: RunIndexEntry): boolean {
    return ["running", "pausing", "paused", "waiting_for_review", "waiting_for_input", "interrupted", "recovery_required"]
      .includes(entry.status)
  }

  private async refreshRunIndex(): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.options.storageDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    this.runIndex.clear()
    this.activeWorkspaces.clear()
    this.reservedLineages.clear()
    this.reservedPaths.clear()
    this.quarantinedWorktrees.length = 0
    for (const entry of entries.filter((candidate) => candidate.endsWith(".json"))) {
      const runId = entry.slice(0, -5)
      try {
        const run = await this.readStoredRun(runId)
        if (!run) continue
        this.indexRun(run)
        if (holdsWorkflowReservation(run)) this.reserveRun(run)
      } catch (error) {
        await this.quarantineMalformedActiveRun(entry)
        this.options.logger.error({ err: error, file: entry }, "Failed to refresh workflow ownership")
      }
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
      let validRun = false
      try {
        const runId = entry.slice(0, -5)
        const recoveryMarker = await this.readRecoveryMarker(runId)
        const metadata = await this.readRunMetadata(entry)
        if (metadata && !recoveryMarker && !this.indexHoldsReservation(metadata) && !metadata.ambiguousSessions) {
          this.runIndex.set(metadata.id, metadata)
          continue
        }
        const run = await this.read(runId)
        if (!run) continue
        validRun = true
        if (this.activeRuns.has(run.id)) {
          this.reserveRun(run)
          continue
        }
        if (this.isLeaseLive(run)) {
          this.reserveRun(run)
          continue
        }
        const hadStaleLease = Boolean(run.executorLease)
        delete run.executorLease
        const recoveryMarked = Boolean(recoveryMarker
          && (recoveryMarker.revision === undefined || (run.revision ?? 0) <= recoveryMarker.revision))
        if (recoveryMarker && !recoveryMarked) await durableRemove(this.recoveryMarkerPath(run.id)).catch((error) => {
          this.options.logger.warn({ err: error, runId: run.id }, "Failed to clear stale workflow recovery marker")
        })
        await this.writeRunMetadata(run).catch((error) => {
          this.options.logger.warn({ err: error, runId: run.id }, "Failed to update workflow run metadata")
        })
        if (recoveryMarked) {
          const message = "Workflow terminal state was not durably persisted; manual recovery is required and prior gate state cannot be reused"
          markWorkflowRecoveryRequired(run, message)
          delete run.activeStepId
          this.reserveRun(run)
          try {
            await this.persist(run)
            await fs.rm(this.recoveryMarkerPath(run.id), { force: true })
          } catch (error) {
            this.admissionFailure = `Workflow admission is blocked because marked recovery state could not be persisted for run ${run.id}; repair storage and restart CodeNomad`
            throw error
          }
          continue
        }
        if (!holdsWorkflowReservation(run)) continue
        const sessionBearing = this.persistedAmbiguousSessionIds(run).size > 0
        const interruptedAction = Boolean(run.definitionSnapshot && run.executionNodes?.some((node) =>
          node.status === "running" && node.attempt > 0 && (node.type === "agent" || node.type === "shell")))
        const legacyAction = !run.definitionSnapshot && run.steps.some((step) => step.status === "running")
        const wasExecuting = run.status === "running" || run.status === "pausing"
        const ambiguous = sessionBearing || interruptedAction || legacyAction
        if (!wasExecuting && ["interrupted", "recovery_required"].includes(run.status)) {
          this.reserveRun(run)
          if (hadStaleLease) await this.persist(run)
          continue
        }
        if (!wasExecuting && !ambiguous) {
          this.reserveRun(run)
          if (hadStaleLease) await this.persist(run)
          continue
        }
        run.error = "CodeNomad restarted before this workflow completed"
        if (ambiguous) markWorkflowRecoveryRequired(run, run.error)
        else run.status = "interrupted"
        const step = run.steps.find((candidate) => candidate.status === "running")
        if (step) {
          step.status = "failed"
          step.error = run.error
          step.completedAt = new Date().toISOString()
        }
        for (const node of run.executionNodes ?? []) {
          if ((node.sessionIds?.length && !["completed", "skipped", "failed", "cancelled"].includes(node.status))
            || (node.status === "running" && node.attempt > 0 && (node.type === "agent" || node.type === "shell"))) {
            node.status = "interrupted"
            node.error = run.error
            node.completedAt = new Date().toISOString()
          } else if (node.status === "running") {
            node.status = "waiting"
          }
        }
        if (run.status === "recovery_required" && this.persistedAmbiguousSessionIds(run).size === 0) {
          run.error = "CodeNomad restarted during an action, but no session ID was persisted; termination cannot be positively confirmed and the action will not be repeated"
          for (const node of run.executionNodes ?? []) if (node.status === "interrupted") node.error = run.error
          if (step) step.error = run.error
        }
        this.reserveRun(run)
        delete run.activeStepId
        await this.persist(run)
      } catch (error) {
        if (validRun) throw error
        await this.quarantineMalformedActiveRun(entry)
        this.options.logger.error({ err: error, file: entry }, "Failed to recover workflow run")
      }
    }
    await this.pruneHistoryEntries().catch((error) => {
      this.options.logger.warn({ err: error }, "Failed to prune global workflow history")
    })
  }

  private async quarantineMalformedActiveRun(entry: string): Promise<void> {
    let value: unknown
    try {
      value = JSON.parse(await fs.readFile(path.join(this.options.storageDir, entry), "utf8"))
    } catch {
      this.admissionFailure = `Workflow admission is blocked by malformed active run ${entry}; remove or repair it and restart CodeNomad`
      return
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.admissionFailure = `Workflow admission is blocked by malformed active run ${entry}; remove or repair it and restart CodeNomad`
      return
    }
    const candidate = value as Record<string, unknown>
    if (["completed", "failed", "cancelled"].includes(candidate.status as string)) return
    const quarantineId = typeof candidate.id === "string" && candidate.id ? candidate.id : `malformed:${entry}`
    let identifiable = false
    if (typeof candidate.workspaceLineageId === "string" && candidate.workspaceLineageId) {
      this.reservedLineages.set(candidate.workspaceLineageId, quarantineId)
      identifiable = true
    }
    if (typeof candidate.workspacePath === "string" && candidate.workspacePath) {
      this.reservedPaths.set(this.pathKey(candidate.workspacePath), quarantineId)
      identifiable = true
    }
    if (typeof candidate.workspaceId === "string" && candidate.workspaceId) {
      this.activeWorkspaces.set(candidate.workspaceId, quarantineId)
    }
    const selection = candidate.worktreeSelection
    if (selection && typeof selection === "object" && !Array.isArray(selection)) {
      const worktree = selection as Record<string, unknown>
      const retained: Partial<RunIndexEntry> = {}
      for (const [field, value] of [
        ["sourceWorkspaceId", worktree.sourceWorkspaceId],
        ["sourceWorkspaceLineageId", worktree.sourceWorkspaceLineageId],
        ["sourceWorkspacePath", worktree.sourceWorkspacePath],
        ["worktreeDirectory", worktree.directory],
        ["worktreeSlug", worktree.slug],
      ] as const) if (typeof value === "string" && value) retained[field] = value
      if (retained.worktreeDirectory || (retained.worktreeSlug
        && (retained.sourceWorkspaceId || retained.sourceWorkspaceLineageId || retained.sourceWorkspacePath))) {
        this.quarantinedWorktrees.push(retained)
        identifiable = true
      }
    }
    if (!identifiable) {
      this.admissionFailure = `Workflow admission is blocked by malformed active run ${entry} without a usable lineage or path; remove or repair it and restart CodeNomad`
    }
  }

  private async persist(run: WorkflowRun, touch = true): Promise<void> {
    const active = this.activeRuns.get(run.id)
    if (active?.run === run && active.leaseLost) throw new WorkflowRunError("Workflow executor ownership was lost", 409)
    const expectedLease = active?.run === run && !active.leaseDurablyReleased
      ? { ownerToken: this.managerToken, fence: active.leaseFence }
      : undefined
    if (run.executorLease?.ownerToken === this.managerToken) {
      run.executorLease.heartbeatAt = new Date().toISOString()
      run.executorLease.expiresAt = this.executorLeaseExpiry(run.executorLease.heartbeatAt)
    }
    if (touch) {
      run.updatedAt = new Date().toISOString()
      run.revision = (run.revision ?? 0) + 1
    }
    validatePersistedWorkflowRun(run, run.id)
    const snapshot = JSON.parse(JSON.stringify(run)) as WorkflowRun
    const previous = this.persistQueues.get(run.id) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(async () => {
      await ensureDurableDirectory(this.options.storageDir)
      const destination = this.runPath(run.id)
      await withFilesystemLock(this.runLockPath(run.id), async (assertOwned) => {
        const current = await this.readStoredRun(run.id)
        if (current) {
          if (expectedLease) {
            const ownsCurrent = this.isLeaseLive(current)
              && current.executorLease?.ownerToken === expectedLease.ownerToken
              && current.executorLease.fence === expectedLease.fence
            const claimsNextFence = !this.isLeaseLive(current)
              && snapshot.executorLease?.ownerToken === expectedLease.ownerToken
              && snapshot.executorLease.fence === expectedLease.fence
              && expectedLease.fence === (current.executorFence ?? 0) + 1
            if (!ownsCurrent && !claimsNextFence) {
              if (active) active.leaseLost = true
              throw new WorkflowRunError("Workflow executor ownership was lost", 409)
            }
          } else {
            this.assertNoLiveForeignLease(current)
          }
          const expectedRevision = touch ? (snapshot.revision ?? 0) - 1 : snapshot.revision ?? 0
          if ((current.revision ?? 0) !== expectedRevision) {
            if (expectedLease && active) active.leaseLost = true
            throw new WorkflowRunError("Workflow run changed on another CodeNomad host", 409)
          }
        } else if (!expectedLease || (snapshot.revision ?? 0) !== 1) {
          throw new WorkflowRunError("Workflow run journal disappeared", 409)
        }
        if (snapshot.executorLease?.ownerToken === this.managerToken) {
          snapshot.executorLease.heartbeatAt = new Date().toISOString()
          snapshot.executorLease.expiresAt = this.executorLeaseExpiry(snapshot.executorLease.heartbeatAt)
          if (run.executorLease?.fence === snapshot.executorLease.fence) {
            run.executorLease.heartbeatAt = snapshot.executorLease.heartbeatAt
            run.executorLease.expiresAt = snapshot.executorLease.expiresAt
          }
        }
        await durableAtomicWrite(destination, `${JSON.stringify(snapshot, null, 2)}\n`, assertOwned)
        if (active?.run === run && !snapshot.executorLease) active.leaseDurablyReleased = true
        await this.writeRunMetadata(snapshot).catch((error) => {
          this.options.logger.warn({ err: error, runId: snapshot.id }, "Failed to update workflow run metadata")
        })
      })
      this.indexRun(snapshot)
      const workspaceIds = new Set([snapshot.workspaceId, snapshot.worktreeSelection?.sourceWorkspaceId].filter(Boolean) as string[])
      for (const instanceId of workspaceIds) this.options.eventBus.publish({
          type: "instance.event",
          instanceId,
          // ponytail: checkpoint events stay compact; clients fetch full state at user-visible boundaries.
          event: { type: "workflow.run.updated", properties: {
            runId: snapshot.id, revision: snapshot.revision, status: snapshot.status, updatedAt: snapshot.updatedAt,
          } },
        })
      if (["completed", "failed", "cancelled"].includes(snapshot.status)) {
        await this.pruneHistory(snapshot.worktreeSelection?.sourceWorkspaceLineageId ?? snapshot.workspaceLineageId).catch((error) => {
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

  private async renewExecutorLease(active: ActiveRun): Promise<void> {
    await (this.persistQueues.get(active.run.id) ?? Promise.resolve()).catch(() => undefined)
    if (active.run.executorLease?.ownerToken !== this.managerToken
      || active.run.executorLease.fence !== active.leaseFence) return
    await withFilesystemLock(this.runLockPath(active.run.id), async (assertOwned) => {
      const current = await this.readStoredRun(active.run.id)
      if (active.run.executorLease?.ownerToken !== this.managerToken
        || active.run.executorLease.fence !== active.leaseFence) return
      if (current?.executorLease?.ownerToken !== this.managerToken
        || current.executorLease.fence !== active.leaseFence
        || !this.isLeaseLive(current)) {
        throw new WorkflowRunError("Workflow executor ownership was lost", 409)
      }
      current.executorLease.heartbeatAt = new Date().toISOString()
      current.executorLease.expiresAt = this.executorLeaseExpiry(current.executorLease.heartbeatAt)
      await durableAtomicWrite(this.runPath(current.id), `${JSON.stringify(current, null, 2)}\n`, assertOwned)
      if (active.run.executorLease?.fence === active.leaseFence) {
        active.run.executorLease.heartbeatAt = current.executorLease.heartbeatAt
        active.run.executorLease.expiresAt = current.executorLease.expiresAt
      }
    })
  }

  private async revalidateExecutorFence(active: ActiveRun): Promise<void> {
    await (this.persistQueues.get(active.run.id) ?? Promise.resolve())
    this.throwIfCancelled(active)
    try {
      await withFilesystemLock(this.runLockPath(active.run.id), async (assertOwned) => {
        const current = await this.readStoredRun(active.run.id)
        await assertOwned()
        if (!current || !["running", "pausing", "waiting_for_review", "waiting_for_input"].includes(current.status)
          || !this.isLeaseLive(current)
          || current.executorLease?.ownerToken !== this.managerToken
          || current.executorLease.fence !== active.leaseFence) {
          throw new WorkflowRunError("Workflow executor ownership was lost", 409)
        }
      })
    } catch (error) {
      active.leaseLost = true
      active.releaseBlocked = true
      active.cancelRequested = true
      active.abortController.abort(new WorkflowCancelledError("Workflow executor lease was lost"))
      throw error
    }
  }

  private async abandonExecutorLease(active: ActiveRun): Promise<void> {
    await withFilesystemLock(this.runLockPath(active.run.id), async (assertOwned) => {
      const current = await this.readStoredRun(active.run.id)
      if (!current) return
      if (current.executorLease?.ownerToken !== this.managerToken
        || current.executorLease.fence !== active.leaseFence) {
        throw new WorkflowRunError("Workflow executor ownership was lost", 409)
      }
      delete current.executorLease
      await durableAtomicWrite(this.runPath(current.id), `${JSON.stringify(current, null, 2)}\n`, assertOwned)
      active.leaseDurablyReleased = true
    })
  }

  private async pruneHistory(workspaceLineageId: string): Promise<void> {
    return this.pruneHistoryEntries(workspaceLineageId)
  }

  private async pruneHistoryEntries(workspaceLineageId?: string): Promise<void> {
    const terminal = Array.from(this.runIndex.values())
      .filter((run) => ["completed", "failed", "cancelled"].includes(run.status))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const lineage = workspaceLineageId
      ? terminal.filter((run) => (run.sourceWorkspaceLineageId ?? run.workspaceLineageId) === workspaceLineageId)
      : []
    const expired = new Set([
      ...terminal.slice(WORKFLOW_HISTORY_LIMIT).map((run) => run.id),
      ...lineage.slice(WORKFLOW_HISTORY_LIMIT).map((run) => run.id),
    ])
    await Promise.all(Array.from(expired).map(async (runId) => {
      await Promise.all([fs.rm(this.runPath(runId), { force: true }), fs.rm(this.runMetadataPath(runId), { force: true })])
      this.runIndex.delete(runId)
    }))
  }
}

function currentProcessOwner(): { hostname: string; pid: number; processStart?: string; bootId?: string } {
  const snapshot = process.platform === "win32"
    ? probeWindowsProcesses(spawnSync, 1_000)
    : probePosixProcesses(spawnSync, 1_000, process.platform, { pids: [process.pid] })
  const identity = snapshot.ok ? snapshot.processes.get(process.pid) : undefined
  return {
    hostname: os.hostname(), pid: process.pid,
    ...(identity ? { processStart: identity.startTime, ...(identity.bootId ? { bootId: identity.bootId } : {}) } : {}),
  }
}

function executorProcessLiveness(pid: number, processStart?: string, bootId?: string): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"
  }
  if (!processStart) return "alive"
  const snapshot = process.platform === "win32"
    ? probeWindowsProcesses(spawnSync, 1_000)
    : probePosixProcesses(spawnSync, 1_000, process.platform, { pids: [pid] })
  if (snapshot.ok) {
    const current = snapshot.processes.get(pid)
    if (!current) return "dead"
    return current.startTime === processStart && (!bootId || current.bootId === bootId) ? "alive" : "dead"
  }
  return "unknown"
}

async function durableAtomicWrite(destination: string, contents: string, assertOwned?: () => Promise<void>): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, "wx")
    try {
      await handle.writeFile(contents, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await assertOwned?.()
    await fs.rename(temporary, destination)
    await assertOwned?.()
    await syncDirectory(path.dirname(destination))
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function durableRemove(destination: string): Promise<void> {
  await fs.rm(destination, { force: true })
  await syncDirectory(path.dirname(destination))
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let directory: fs.FileHandle | undefined
  try {
    directory = await fs.open(directoryPath, "r")
    await directory.sync()
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
  } finally {
    await directory?.close()
  }
}

async function ensureDurableDirectory(directoryPath: string): Promise<void> {
  const created = await fs.mkdir(directoryPath, { recursive: true })
  if (!created) return
  const firstCreated = path.resolve(created)
  let current = path.resolve(directoryPath)
  while (true) {
    await syncDirectory(path.dirname(current))
    if (current === firstCreated) return
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}
