import type {
  WorkflowDefinitionV1,
  WorkflowDefinitionRecord,
  WorkflowDefinitionRunCreateRequest,
  WorkflowNode,
  WorkflowRun,
  WorkflowUsage,
} from "../api-types"
import { parseWorkflowDefinition, WORKFLOW_LIMITS } from "./definition-schema"

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const emptyWorkflowUsage = (): WorkflowUsage => ({
  cost: 0,
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

export const definitionRunFields = (
  record: WorkflowDefinitionRecord,
  input: WorkflowDefinitionRunCreateRequest,
): Pick<WorkflowRun, "definitionId" | "definitionRevision" | "definitionSnapshot" | "inputs" | "executionNodes" | "usage"> => ({
  definitionId: record.id,
  definitionRevision: record.revision,
  definitionSnapshot: clone(record.definition),
  inputs: clone(input.inputs ?? {}),
  executionNodes: [],
  usage: emptyWorkflowUsage(),
})

export const holdsWorkflowReservation = (run: WorkflowRun) =>
  ["running", "pausing", "paused", "waiting_for_review", "waiting_for_input", "interrupted", "recovery_required"].includes(run.status)

export function markWorkflowRecoveryRequired(run: WorkflowRun, message: string) {
  run.status = "recovery_required"
  run.error = message
  for (const node of run.executionNodes ?? []) {
    if (node.status !== "running" && node.status !== "waiting"
      && !(node.sessionIds?.length && !["completed", "skipped", "failed", "cancelled"].includes(node.status))) continue
    node.status = "interrupted"
    node.error = message
    node.completedAt = new Date().toISOString()
  }
  run.pauseRequested = false
  delete run.pendingGate
}

const RUN_STATUSES = new Set([
  "running", "pausing", "paused", "waiting_for_review", "waiting_for_input",
  "completed", "failed", "cancelled", "interrupted", "recovery_required",
])
const EXECUTION_STATUSES = new Set(["pending", "running", "waiting", "completed", "skipped", "failed", "cancelled", "interrupted"])
const EXECUTION_TYPES = new Set(["sequence", "parallel", "foreach", "repeat", "agent", "shell", "gate", "condition", "workflow"])
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0
const SESSION_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const isTimestamp = (value: unknown): value is string => isNonEmptyString(value) && Number.isFinite(Date.parse(value))
const validUsage = (usage: WorkflowUsage) => Object.values(usage).every((value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0)

export function validatePersistedWorkflowRun(value: unknown, runId: string): asserts value is WorkflowRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid stored workflow run ${runId}`)
  const run = value as WorkflowRun
  if (run.id !== runId
    || !isNonEmptyString(run.workspaceId)
    || !isNonEmptyString(run.workspaceLineageId)
    || !isNonEmptyString(run.workspacePath)
    || !isNonEmptyString(run.objective)
    || !RUN_STATUSES.has(run.status)
    || !isTimestamp(run.createdAt)
    || !isTimestamp(run.updatedAt)
    || !Array.isArray(run.steps)) {
    throw new Error(`Invalid stored workflow run ${runId}`)
  }
  if (run.usage && !validUsage(run.usage)) throw new Error(`Invalid workflow usage for workflow run ${runId}`)
  if (run.sessionBindings !== undefined && (
    !run.sessionBindings || typeof run.sessionBindings !== "object" || Array.isArray(run.sessionBindings)
    || Object.entries(run.sessionBindings).length > WORKFLOW_LIMITS.expandedNodes
    || Object.entries(run.sessionBindings).some(([key, sessionId]) =>
      key.length > 100 || !SESSION_KEY_PATTERN.test(key) || !isNonEmptyString(sessionId) || sessionId.length > 200)
  )) throw new Error(`Invalid session bindings for workflow run ${runId}`)
  if (!run.definitionSnapshot) return
  const { definition } = parseWorkflowDefinition(run.definitionSnapshot)
  if (run.definitionId !== definition.id || !Number.isInteger(run.definitionRevision) || run.definitionRevision! < 1) {
    throw new Error(`Invalid definition snapshot for workflow run ${runId}`)
  }
  const expandedLimit = definition.maxExpandedNodes ?? WORKFLOW_LIMITS.expandedNodes
  if (!Array.isArray(run.executionNodes) || run.executionNodes.length > expandedLimit) {
    throw new Error(`Invalid execution nodes for workflow run ${runId}`)
  }
  if (Object.keys(run.sessionBindings ?? {}).length > expandedLimit) {
    throw new Error(`Too many session bindings for workflow run ${runId}`)
  }
  if (new Set(run.executionNodes.map((node) => node.id)).size !== run.executionNodes.length
    || new Set(run.executionNodes.map((node) => node.instanceKey)).size !== run.executionNodes.length) {
    throw new Error(`Duplicate execution nodes for workflow run ${runId}`)
  }
  for (const node of run.executionNodes) {
    if (!isNonEmptyString(node.id) || !isNonEmptyString(node.instanceKey) || !isNonEmptyString(node.definitionNodeId)
      || (node.definitionInvocationKey !== undefined && !isNonEmptyString(node.definitionInvocationKey))
      || !EXECUTION_TYPES.has(node.type) || !EXECUTION_STATUSES.has(node.status) || !Number.isInteger(node.attempt) || node.attempt < 0
      || (node.sessionIds !== undefined && (!Array.isArray(node.sessionIds) || node.sessionIds.some((id) => !isNonEmptyString(id))))
      || (node.usage && !validUsage(node.usage))) {
      throw new Error(`Invalid execution node for workflow run ${runId}`)
    }
  }
  const snapshots = run.savedDefinitionSnapshots ?? []
  if (snapshots.length > WORKFLOW_LIMITS.staticNodes) throw new Error(`Too many saved definition snapshots for workflow run ${runId}`)
  const byKey = new Map<string, WorkflowDefinitionV1>()
  for (const snapshot of snapshots) {
    const parsed = parseWorkflowDefinition(snapshot.definition).definition
    if (snapshot.id !== parsed.id || !Number.isInteger(snapshot.revision) || snapshot.revision < 1) {
      throw new Error(`Invalid saved definition snapshot for workflow run ${runId}`)
    }
    const key = `${snapshot.id}@${snapshot.revision}`
    if (byKey.has(key)) throw new Error(`Duplicate saved definition snapshot for workflow run ${runId}`)
    byKey.set(key, parsed)
  }
  const inspect = (node: typeof definition.root, stack: string[], depth: number): void => {
    if (depth > WORKFLOW_LIMITS.nestingDepth) throw new Error(`Saved workflow nesting is too deep for workflow run ${runId}`)
    if (node.type === "workflow") {
      const key = `${node.definitionId}@${node.definitionRevision}`
      const snapshot = byKey.get(key)
      if (!snapshot || !node.definitionRevision) throw new Error(`Missing saved definition snapshot for workflow run ${runId}`)
      if (stack.includes(snapshot.id)) throw new Error(`Saved workflow cycle in workflow run ${runId}`)
      inspect(snapshot.root, [...stack, snapshot.id], depth + 1)
      return
    }
    const children = node.type === "sequence" ? node.steps
      : node.type === "parallel" ? node.branches
        : node.type === "foreach" || node.type === "repeat" ? [node.body]
          : node.type === "condition" ? [node.then, ...(node.else ? [node.else] : [])]
            : []
    for (const child of children) inspect(child, stack, depth)
  }
  inspect(definition.root, [definition.id], 0)
  const typesByDefinition = new Map<string, Map<string, WorkflowNode["type"]>>()
  const collectTypes = (key: string, root: WorkflowNode) => {
    const types = new Map<string, WorkflowNode["type"]>()
    const visit = (node: WorkflowNode): void => {
      types.set(node.id, node.type)
      const children = node.type === "sequence" ? node.steps
        : node.type === "parallel" ? node.branches
          : node.type === "foreach" || node.type === "repeat" ? [node.body]
            : node.type === "condition" ? [node.then, ...(node.else ? [node.else] : [])]
              : []
      for (const child of children) visit(child)
    }
    visit(root)
    typesByDefinition.set(key, types)
  }
  const rootKey = `${run.definitionId}@${run.definitionRevision}`
  collectTypes(rootKey, definition.root)
  for (const [key, snapshot] of byKey) collectTypes(key, snapshot.root)
  for (const node of run.executionNodes) {
    const segments = node.instanceKey.split("/")
    const savedInvocation = segments.map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => byKey.has(segment)).at(-1)
    const definitionKey = savedInvocation?.segment ?? rootKey
    const invocationKey = savedInvocation ? segments.slice(0, savedInvocation.index + 1).join("/") : rootKey
    if (node.definitionInvocationKey !== undefined && node.definitionInvocationKey !== invocationKey) {
      throw new Error(`Invalid definition invocation scope for workflow run ${runId}`)
    }
    if (typesByDefinition.get(definitionKey)?.get(node.definitionNodeId) !== node.type) {
      throw new Error(`Execution node does not match the pinned graph for workflow run ${runId}`)
    }
  }
  if (run.worktreeSelection) {
    const selection = run.worktreeSelection
    if (selection.workspaceId !== run.workspaceId || selection.directory !== run.workspacePath
      || !selection.sourceWorkspaceId || !selection.sourceWorkspaceLineageId || !selection.sourceWorkspacePath) {
      throw new Error(`Invalid worktree selection for workflow run ${runId}`)
    }
    if (selection.policy.mode !== "current" && selection.policy.slug !== selection.slug) {
      throw new Error(`Invalid worktree selection for workflow run ${runId}`)
    }
  }
}
