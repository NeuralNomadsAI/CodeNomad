import { createSignal } from "solid-js"
import type { WorkflowRun } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import { sseManager } from "../lib/sse-manager"
import { reconcileWorkflowRunList, reconcileWorkflowRuns } from "./workflow-reconciliation"

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

export interface WorkflowStatusTransition {
  runId: string
  status: WorkflowRun["status"]
  updatedAt: string
}

const [workflowRuns, setWorkflowRuns] = createSignal<Map<string, WorkflowRun[]>>(new Map())
const [workflowLoading, setWorkflowLoading] = createSignal<Map<string, boolean>>(new Map())
const [workflowErrors, setWorkflowErrors] = createSignal<Map<string, string>>(new Map())
const [workflowStatusTransitions, setWorkflowStatusTransitions] = createSignal<Map<string, WorkflowStatusTransition>>(new Map())
const [workflowDrafts, setWorkflowDrafts] = createSignal<Map<string, WorkflowDraft>>(new Map())
const trackedInstances = new Set<string>()
const workflowRunRevisions = new Map<string, Map<string, number>>()
let workflowRevision = 0

function setMapValue<T>(setter: (value: (previous: Map<string, T>) => Map<string, T>) => void, instanceId: string, value: T) {
  setter((previous) => {
    const next = new Map(previous)
    next.set(instanceId, value)
    return next
  })
}

function upsertWorkflowRun(instanceId: string, run: WorkflowRun) {
  trackedInstances.add(instanceId)
  const revisions = workflowRunRevisions.get(instanceId) ?? new Map<string, number>()
  revisions.set(run.id, ++workflowRevision)
  workflowRunRevisions.set(instanceId, revisions)
  setWorkflowRuns((previous) => {
    const next = new Map(previous)
    next.set(instanceId, reconcileWorkflowRuns(next.get(instanceId) ?? [], [run]))
    return next
  })
}

async function loadWorkflowRuns(instanceId: string): Promise<void> {
  trackedInstances.add(instanceId)
  setMapValue(setWorkflowLoading, instanceId, true)
  setMapValue(setWorkflowErrors, instanceId, "")
  const requestedRevision = workflowRevision
  try {
    const response = await serverApi.listWorkflowRuns(instanceId)
    setWorkflowRuns((previous) => {
      const next = new Map(previous)
      const concurrentRunIds = new Set([...(workflowRunRevisions.get(instanceId) ?? [])]
        .filter(([, revision]) => revision > requestedRevision)
        .map(([runId]) => runId))
      next.set(instanceId, reconcileWorkflowRunList(next.get(instanceId) ?? [], response.runs, concurrentRunIds))
      return next
    })
  } catch (error) {
    setMapValue(setWorkflowErrors, instanceId, error instanceof Error ? error.message : String(error))
  } finally {
    setMapValue(setWorkflowLoading, instanceId, false)
  }
}

async function createWorkflowRun(instanceId: string, draft: WorkflowDraft): Promise<WorkflowRun> {
  const run = await serverApi.createWorkflowRun(instanceId, draft)
  upsertWorkflowRun(instanceId, run)
  return run
}

async function approveWorkflowRun(instanceId: string, runId: string): Promise<WorkflowRun> {
  const run = await serverApi.approveWorkflowRun(instanceId, runId)
  upsertWorkflowRun(instanceId, run)
  return run
}

async function cancelWorkflowRun(instanceId: string, runId: string): Promise<WorkflowRun> {
  const run = await serverApi.cancelWorkflowRun(instanceId, runId)
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

sseManager.onWorkflowRunUpdated = (instanceId, event) => {
  const run = event.properties?.run
  if (!run) return
  const previousStatus = getWorkflowRuns(instanceId).find((entry) => entry.id === run.id)?.status
  upsertWorkflowRun(instanceId, run)
  if (previousStatus !== run.status) {
    setMapValue(setWorkflowStatusTransitions, instanceId, {
      runId: run.id,
      status: run.status,
      updatedAt: run.updatedAt,
    })
  }
}

serverEvents.onOpen(() => {
  for (const instanceId of trackedInstances) void loadWorkflowRuns(instanceId)
})

export {
  workflowRuns,
  workflowLoading,
  workflowErrors,
  workflowStatusTransitions,
  workflowDrafts,
  getWorkflowRuns,
  getWorkflowDraft,
  setWorkflowDraft,
  loadWorkflowRuns,
  upsertWorkflowRun,
  createWorkflowRun,
  approveWorkflowRun,
  cancelWorkflowRun,
}
