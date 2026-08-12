import { createSignal } from "solid-js"
import type { WorkflowDefinitionRecord, WorkflowRun } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import { sseManager } from "../lib/sse-manager"
import {
  compareWorkflowRuns,
  createWorkflowResponseFence,
  reconcileWorkflowDefinitions,
  reconcileWorkflowRunList,
  reconcileWorkflowRuns,
} from "./workflow-reconciliation"
import { createWorkflowRefreshCoordinator } from "./workflow-refresh"

export interface WorkflowDraftStage {
  id: string
  title: string
  instructions: string
  agent?: string
  model?: { providerId: string; modelId: string }
  requiresApproval?: boolean
}

export interface WorkflowDraft {
  objective: string
  initiatorSessionId?: string
  stages: WorkflowDraftStage[]
}

export interface WorkflowDeclarativeDraft {
  selectedDefinitionId: string
  baselineRevision?: number
  source: string
  objective: string
  inputs: string
}

export interface WorkflowStatusTransition {
  runId: string
  status: WorkflowRun["status"]
  updatedAt: string
}

const [workflowRuns, setWorkflowRuns] = createSignal<Map<string, WorkflowRun[]>>(new Map())
const [workflowLoading, setWorkflowLoading] = createSignal<Map<string, boolean>>(new Map())
const [workflowErrors, setWorkflowErrors] = createSignal<Map<string, unknown>>(new Map())
const [workflowStatusTransitions, setWorkflowStatusTransitions] = createSignal<Map<string, WorkflowStatusTransition>>(new Map())
const [workflowDrafts, setWorkflowDrafts] = createSignal<Map<string, WorkflowDraft>>(new Map())
const [workflowDeclarativeDrafts, setWorkflowDeclarativeDrafts] = createSignal<Map<string, WorkflowDeclarativeDraft>>(new Map())
const [workflowDefinitions, setWorkflowDefinitions] = createSignal<WorkflowDefinitionRecord[]>([])
const [workflowDefinitionsLoading, setWorkflowDefinitionsLoading] = createSignal(false)
const [workflowDefinitionsError, setWorkflowDefinitionsError] = createSignal<unknown>()
const [workflowDefinitionTombstones, setWorkflowDefinitionTombstones] = createSignal<ReadonlySet<string>>(new Set())
const [workflowRunHydrationRevisions, setWorkflowRunHydrationRevisions] = createSignal<ReadonlyMap<string, number>>(new Map())
const trackedInstances = new Set<string>()
const workflowRunRevisions = new Map<string, Map<string, number>>()
const workflowRunLoadGenerations = new Map<string, number>()
const workflowDefinitionListFence = createWorkflowResponseFence()
const workflowDefinitionMutationGenerations = new Map<string, number>()
const pendingWorkflowDefinitionMutations = new Set<string>()
const mountedWorkflowInstances = new Map<string, number>()
const workflowRunRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const workflowRunRetryAttempts = new Map<string, number>()
let workflowRevision = 0
let workflowDefinitionMutationGeneration = 0

const workflowRunKey = (instanceId: string, runId: string) => JSON.stringify([instanceId, runId])

function clearWorkflowRunRetry(key: string): void {
  const timer = workflowRunRetryTimers.get(key)
  if (timer) clearTimeout(timer)
  workflowRunRetryTimers.delete(key)
  workflowRunRetryAttempts.delete(key)
}

function markWorkflowRunHydrating(instanceId: string, runId: string, revision: number): void {
  const key = workflowRunKey(instanceId, runId)
  if (workflowRunHydrationRevisions().get(key) !== revision) clearWorkflowRunRetry(key)
  setWorkflowRunHydrationRevisions((current) => {
    if ((current.get(key) ?? -1) >= revision) return current
    return new Map(current).set(key, revision)
  })
}

function markWorkflowRunHydrated(instanceId: string, run: WorkflowRun): void {
  const key = workflowRunKey(instanceId, run.id)
  const pendingRevision = workflowRunHydrationRevisions().get(key)
  if (pendingRevision === undefined || run.revision === undefined || run.revision < pendingRevision) return
  setWorkflowRunHydrationRevisions((current) => {
    if (current.get(key) !== pendingRevision) return current
    const next = new Map(current)
    next.delete(key)
    return next
  })
  clearWorkflowRunRetry(key)
}

function isWorkflowRunHydrating(instanceId: string, runId: string): boolean {
  return workflowRunHydrationRevisions().has(workflowRunKey(instanceId, runId))
}

function setMapValue<T>(setter: (value: (previous: Map<string, T>) => Map<string, T>) => void, instanceId: string, value: T) {
  setter((previous) => {
    const next = new Map(previous)
    next.set(instanceId, value)
    return next
  })
}

function upsertWorkflowRun(instanceId: string, run: WorkflowRun, hydrated = true): boolean {
  trackedInstances.add(instanceId)
  const existing = getWorkflowRuns(instanceId).find((entry) => entry.id === run.id)
  if (existing && compareWorkflowRuns(run, existing) < 0) return false
  const revisions = workflowRunRevisions.get(instanceId) ?? new Map<string, number>()
  revisions.set(run.id, ++workflowRevision)
  workflowRunRevisions.set(instanceId, revisions)
  setWorkflowRuns((previous) => {
    const next = new Map(previous)
    next.set(instanceId, reconcileWorkflowRuns(next.get(instanceId) ?? [], [run]))
    return next
  })
  if (hydrated) markWorkflowRunHydrated(instanceId, run)
  return true
}

async function loadWorkflowRuns(instanceId: string, options?: { propagateErrors?: boolean }): Promise<void> {
  trackedInstances.add(instanceId)
  setMapValue(setWorkflowLoading, instanceId, true)
  setMapValue(setWorkflowErrors, instanceId, undefined)
  const requestedRevision = workflowRevision
  const generation = (workflowRunLoadGenerations.get(instanceId) ?? 0) + 1
  workflowRunLoadGenerations.set(instanceId, generation)
  try {
    const response = await serverApi.listWorkflowRuns(instanceId)
    if (workflowRunLoadGenerations.get(instanceId) !== generation) {
      if (options?.propagateErrors) throw new Error("workflow_run_refresh_stale")
      return
    }
    setWorkflowRuns((previous) => {
      const next = new Map(previous)
      const concurrentRunIds = new Set([...(workflowRunRevisions.get(instanceId) ?? [])]
        .filter(([, revision]) => revision > requestedRevision)
        .map(([runId]) => runId))
      next.set(instanceId, reconcileWorkflowRunList(next.get(instanceId) ?? [], response.runs, concurrentRunIds))
      return next
    })
    for (const run of response.runs) markWorkflowRunHydrated(instanceId, run)
  } catch (error) {
    if (workflowRunLoadGenerations.get(instanceId) === generation) {
      setMapValue(setWorkflowErrors, instanceId, error)
    }
    if (options?.propagateErrors) throw error
  } finally {
    if (workflowRunLoadGenerations.get(instanceId) === generation) setMapValue(setWorkflowLoading, instanceId, false)
  }
}

async function createWorkflowRun(instanceId: string, draft: WorkflowDraft): Promise<WorkflowRun> {
  const run = await serverApi.createWorkflowRun(instanceId, draft)
  upsertWorkflowRun(instanceId, run)
  return run
}

async function loadWorkflowDefinitions(options?: { propagateErrors?: boolean }): Promise<void> {
  const generation = workflowDefinitionListFence.next()
  setWorkflowDefinitionsLoading(true)
  setWorkflowDefinitionsError(undefined)
  try {
    const incoming = (await serverApi.listWorkflowDefinitions()).definitions
    if (!workflowDefinitionListFence.isCurrent(generation)) {
      if (options?.propagateErrors) throw new Error("workflow_definition_refresh_stale")
      return
    }
    setWorkflowDefinitions((current) => reconcileWorkflowDefinitions(
      current, incoming, pendingWorkflowDefinitionMutations, workflowDefinitionTombstones(),
    ))
  } catch (error) {
    if (workflowDefinitionListFence.isCurrent(generation)) setWorkflowDefinitionsError(error)
    if (options?.propagateErrors) throw error
  } finally {
    if (workflowDefinitionListFence.isCurrent(generation)) setWorkflowDefinitionsLoading(false)
  }
}

function upsertWorkflowDefinition(record: WorkflowDefinitionRecord): void {
  if (workflowDefinitionTombstones().has(record.id)) return
  setWorkflowDefinitions((current) => {
    const existing = current.find(({ id }) => id === record.id)
    if (existing && existing.revision > record.revision) return current
    return [...current.filter(({ id }) => id !== record.id), record]
      .sort((left, right) => left.definition.name.localeCompare(right.definition.name))
  })
}

function invalidateWorkflowDefinitionLists(): void {
  workflowDefinitionListFence.next()
  setWorkflowDefinitionsLoading(false)
}

async function createWorkflowDefinition(source: string): Promise<WorkflowDefinitionRecord> {
  const record = await serverApi.createWorkflowDefinition(source)
  invalidateWorkflowDefinitionLists()
  setWorkflowDefinitionTombstones((current) => {
    if (!current.has(record.id)) return current
    const next = new Set(current)
    next.delete(record.id)
    return next
  })
  upsertWorkflowDefinition(record)
  return record
}

async function updateWorkflowDefinition(id: string, revision: number, source: string): Promise<WorkflowDefinitionRecord> {
  const current = workflowDefinitions().find((record) => record.id === id)
  if (!current || current.revision !== revision || workflowDefinitionTombstones().has(id)) throw new Error("workflow_definition_stale")
  const generation = ++workflowDefinitionMutationGeneration
  workflowDefinitionMutationGenerations.set(id, generation)
  pendingWorkflowDefinitionMutations.add(id)
  try {
    const record = await serverApi.updateWorkflowDefinition(id, revision, source)
    if (workflowDefinitionMutationGenerations.get(id) !== generation || workflowDefinitionTombstones().has(id)) {
      throw new Error("workflow_definition_stale")
    }
    invalidateWorkflowDefinitionLists()
    upsertWorkflowDefinition(record)
    return record
  } finally {
    if (workflowDefinitionMutationGenerations.get(id) === generation) pendingWorkflowDefinitionMutations.delete(id)
  }
}

async function reloadWorkflowDefinition(id: string): Promise<WorkflowDefinitionRecord> {
  if (workflowDefinitionTombstones().has(id)) throw new Error("workflow_definition_stale")
  const generation = ++workflowDefinitionMutationGeneration
  workflowDefinitionMutationGenerations.set(id, generation)
  pendingWorkflowDefinitionMutations.add(id)
  try {
    const record = await serverApi.getWorkflowDefinition(id)
    if (workflowDefinitionMutationGenerations.get(id) !== generation || workflowDefinitionTombstones().has(id)) {
      throw new Error("workflow_definition_stale")
    }
    invalidateWorkflowDefinitionLists()
    upsertWorkflowDefinition(record)
    return record
  } finally {
    if (workflowDefinitionMutationGenerations.get(id) === generation) pendingWorkflowDefinitionMutations.delete(id)
  }
}

async function deleteWorkflowDefinition(id: string, revision: number): Promise<void> {
  const generation = ++workflowDefinitionMutationGeneration
  workflowDefinitionMutationGenerations.set(id, generation)
  pendingWorkflowDefinitionMutations.add(id)
  try {
    await serverApi.deleteWorkflowDefinition(id, revision)
    invalidateWorkflowDefinitionLists()
    setWorkflowDefinitionTombstones((current) => new Set(current).add(id))
    setWorkflowDefinitions((current) => current.filter((definition) => definition.id !== id))
    setWorkflowDeclarativeDrafts((current) => new Map([...current].map(([instanceId, draft]) => [
      instanceId,
      draft.selectedDefinitionId === id
        ? { selectedDefinitionId: "", source: "", objective: "", inputs: "{}" }
        : draft,
    ])))
  } finally {
    if (workflowDefinitionMutationGenerations.get(id) === generation) pendingWorkflowDefinitionMutations.delete(id)
  }
}

async function startWorkflowDefinition(
  instanceId: string,
  id: string,
  revision: number,
  objective: string | undefined,
  inputs: Record<string, unknown> | undefined,
  initiatorSessionId?: string,
): Promise<WorkflowRun> {
  const selected = workflowDefinitions().find((record) => record.id === id)
  if (!selected || selected.revision !== revision || workflowDefinitionTombstones().has(id)) throw new Error("workflow_definition_stale")
  const latest = await serverApi.getWorkflowDefinition(id)
  if (workflowDefinitionTombstones().has(id)) throw new Error("workflow_definition_stale")
  upsertWorkflowDefinition(latest)
  const current = workflowDefinitions().find((record) => record.id === id)
  if (latest.revision !== revision || current?.revision !== revision || workflowDefinitionTombstones().has(id)) {
    throw new Error("workflow_definition_stale")
  }
  const run = await serverApi.startWorkflowDefinition(id, {
    workspaceId: instanceId,
    definitionRevision: revision,
    objective,
    inputs,
    initiatorSessionId,
  })
  upsertWorkflowRun(instanceId, run)
  return run
}

async function approveWorkflowRun(instanceId: string, runId: string, expectedStepId: string): Promise<WorkflowRun> {
  const run = await serverApi.approveWorkflowRun(instanceId, runId, expectedStepId)
  upsertWorkflowRun(instanceId, run)
  return run
}

async function cancelWorkflowRun(instanceId: string, runId: string): Promise<WorkflowRun> {
  const run = await serverApi.cancelWorkflowRun(instanceId, runId)
  upsertWorkflowRun(instanceId, run)
  return run
}

async function pauseWorkflowRun(instanceId: string, runId: string): Promise<WorkflowRun> {
  const run = await serverApi.pauseWorkflowRun(runId)
  upsertWorkflowRun(instanceId, run)
  return run
}

async function resumeWorkflowRun(instanceId: string, runId: string, confirmRecovery = false, expectedRevision?: number): Promise<WorkflowRun> {
  const run = await serverApi.resumeWorkflowRun(runId, confirmRecovery
    ? { confirmRecovery: true, expectedRevision: expectedRevision! }
    : {})
  upsertWorkflowRun(instanceId, run)
  return run
}

async function answerWorkflowGate(instanceId: string, runId: string, executionNodeId: string, answer: unknown): Promise<WorkflowRun> {
  const run = await serverApi.answerWorkflowGate(runId, { executionNodeId, answer })
  upsertWorkflowRun(instanceId, run)
  return run
}

function getWorkflowRuns(instanceId: string): WorkflowRun[] {
  return workflowRuns().get(instanceId) ?? []
}

function getWorkflowDraft(instanceId: string): WorkflowDraft | undefined {
  return workflowDrafts().get(instanceId)
}

function setWorkflowDraft(instanceId: string, draft: WorkflowDraft): void {
  setMapValue(setWorkflowDrafts, instanceId, { ...draft, stages: draft.stages.map((stage) => ({ ...stage })) })
}

function getWorkflowDeclarativeDraft(instanceId: string): WorkflowDeclarativeDraft | undefined {
  return workflowDeclarativeDrafts().get(instanceId)
}

function setWorkflowDeclarativeDraft(instanceId: string, draft: WorkflowDeclarativeDraft): void {
  setMapValue(setWorkflowDeclarativeDrafts, instanceId, { ...draft })
}

function scheduleWorkflowRunRefresh(instanceId: string, runId: string, revision: number): void {
  const key = workflowRunKey(instanceId, runId)
  if (!mountedWorkflowInstances.has(instanceId)
    || !getWorkflowRuns(instanceId).some(({ id }) => id === runId)
    || workflowRunHydrationRevisions().get(key) !== revision
    || workflowRunRetryTimers.has(key)) return
  const attempt = (workflowRunRetryAttempts.get(key) ?? 0) + 1
  workflowRunRetryAttempts.set(key, attempt)
  const timer = setTimeout(() => {
    workflowRunRetryTimers.delete(key)
    if (mountedWorkflowInstances.has(instanceId)
      && getWorkflowRuns(instanceId).some(({ id }) => id === runId)
      && workflowRunHydrationRevisions().get(key) === revision) {
      void refreshWorkflowRun(instanceId, runId, revision)
    }
  }, Math.min(250 * (2 ** (attempt - 1)), 5_000))
  workflowRunRetryTimers.set(key, timer)
}

function mountWorkflowInstance(instanceId: string): () => void {
  mountedWorkflowInstances.set(instanceId, (mountedWorkflowInstances.get(instanceId) ?? 0) + 1)
  for (const [key, revision] of workflowRunHydrationRevisions()) {
    const [pendingInstanceId, runId] = JSON.parse(key) as [string, string]
    if (pendingInstanceId === instanceId) void refreshWorkflowRun(instanceId, runId, revision)
  }
  return () => {
    const remaining = (mountedWorkflowInstances.get(instanceId) ?? 1) - 1
    if (remaining > 0) {
      mountedWorkflowInstances.set(instanceId, remaining)
      return
    }
    mountedWorkflowInstances.delete(instanceId)
    for (const key of workflowRunRetryTimers.keys()) {
      const [pendingInstanceId] = JSON.parse(key) as [string, string]
      if (pendingInstanceId === instanceId) clearWorkflowRunRetry(key)
    }
  }
}

const requestWorkflowRunRefresh = createWorkflowRefreshCoordinator(async (instanceId, runId, revision) => {
  try {
    const run = await serverApi.getWorkflowRun(instanceId, runId)
    upsertWorkflowRun(instanceId, run)
    if (revision !== undefined && (run.revision === undefined || run.revision < revision)) {
      scheduleWorkflowRunRefresh(instanceId, runId, revision)
    }
  } catch {
    if (revision !== undefined) scheduleWorkflowRunRefresh(instanceId, runId, revision)
  }
})

function refreshWorkflowRun(instanceId: string, runId: string, revision?: number): Promise<void> {
  return requestWorkflowRunRefresh(instanceId, runId, revision)
}

sseManager.onWorkflowRunUpdated = (instanceId, event) => {
  const run = event.properties?.run
  const runId = run?.id ?? event.properties?.runId
  if (!runId) return
  const existing = getWorkflowRuns(instanceId).find((entry) => entry.id === runId)
  const status = run?.status ?? event.properties?.status
  const shouldRefresh = !run && (!existing || (status !== "running" && status !== "pausing"))
  if (shouldRefresh && event.properties?.revision !== undefined
    && (existing?.revision === undefined || event.properties.revision > existing.revision)) {
    markWorkflowRunHydrating(instanceId, runId, event.properties.revision)
  }
  const updated = run ?? (existing && status ? {
    ...existing,
    status,
    ...(shouldRefresh || ["running", "pausing"].includes(status)
      ? { pendingGate: undefined, pendingReviewStepId: undefined }
      : {}),
    ...(event.properties?.revision === undefined ? {} : { revision: event.properties.revision }),
    ...(event.properties?.updatedAt ? { updatedAt: event.properties.updatedAt } : {}),
  } : undefined)
  if (updated && upsertWorkflowRun(instanceId, updated, Boolean(run)) && existing?.status !== updated.status) {
    setMapValue(setWorkflowStatusTransitions, instanceId, {
      runId,
      status: updated.status,
      updatedAt: updated.updatedAt,
    })
  }
  if (shouldRefresh) void refreshWorkflowRun(instanceId, runId, event.properties?.revision)
}

serverEvents.onOpen(() => {
  for (const instanceId of trackedInstances) void loadWorkflowRuns(instanceId)
  void loadWorkflowDefinitions()
})

serverEvents.onReplayReset(async () => {
  await Promise.all([
    loadWorkflowDefinitions({ propagateErrors: true }),
    ...Array.from(trackedInstances, (instanceId) => loadWorkflowRuns(instanceId, { propagateErrors: true })),
  ])
})

export {
  workflowRuns,
  workflowLoading,
  workflowErrors,
  workflowStatusTransitions,
  workflowDrafts,
  workflowDeclarativeDrafts,
  workflowDefinitions,
  workflowDefinitionsLoading,
  workflowDefinitionsError,
  workflowDefinitionTombstones,
  isWorkflowRunHydrating,
  refreshWorkflowRun,
  mountWorkflowInstance,
  getWorkflowRuns,
  getWorkflowDraft,
  setWorkflowDraft,
  getWorkflowDeclarativeDraft,
  setWorkflowDeclarativeDraft,
  loadWorkflowRuns,
  upsertWorkflowRun,
  createWorkflowRun,
  loadWorkflowDefinitions,
  createWorkflowDefinition,
  updateWorkflowDefinition,
  reloadWorkflowDefinition,
  deleteWorkflowDefinition,
  startWorkflowDefinition,
  approveWorkflowRun,
  cancelWorkflowRun,
  pauseWorkflowRun,
  resumeWorkflowRun,
  answerWorkflowGate,
}
