import type { WorkflowDefinitionRecord, WorkflowRun } from "../../../server/src/api-types"

const updatedAt = (run: WorkflowRun) => Date.parse(run.updatedAt) || 0
export const WORKFLOW_CLIENT_HISTORY_LIMIT = 100

export function createWorkflowResponseFence() {
  let generation = 0
  return {
    next: () => ++generation,
    isCurrent: (candidate: number) => candidate === generation,
  }
}

export function reconcileWorkflowDefinitions(
  current: WorkflowDefinitionRecord[],
  incoming: WorkflowDefinitionRecord[],
  pendingIds: ReadonlySet<string>,
  deletedIds: ReadonlySet<string>,
): WorkflowDefinitionRecord[] {
  const incomingById = new Map(incoming.filter(({ id }) => !deletedIds.has(id)).map((record) => [record.id, record]))
  for (const record of current) {
    if (deletedIds.has(record.id)) continue
    const candidate = incomingById.get(record.id)
    if (pendingIds.has(record.id) || (candidate && record.revision > candidate.revision)) incomingById.set(record.id, record)
  }
  return [...incomingById.values()].sort((left, right) => left.definition.name.localeCompare(right.definition.name))
}

export function compareWorkflowRuns(incoming: WorkflowRun, existing: WorkflowRun): number {
  if (incoming.revision !== undefined && existing.revision !== undefined) return incoming.revision - existing.revision
  return updatedAt(incoming) - updatedAt(existing)
}

export function reconcileWorkflowRuns(current: WorkflowRun[], incoming: WorkflowRun[]): WorkflowRun[] {
  const byId = new Map(current.map((run) => [run.id, run]))
  for (const run of incoming) {
    const existing = byId.get(run.id)
    if (!existing || compareWorkflowRuns(run, existing) >= 0) byId.set(run.id, run)
  }
  return [...byId.values()]
    .sort((left, right) => updatedAt(right) - updatedAt(left))
    .slice(0, WORKFLOW_CLIENT_HISTORY_LIMIT)
}

export function reconcileWorkflowRunList(
  current: WorkflowRun[],
  incoming: WorkflowRun[],
  concurrentRunIds: ReadonlySet<string>,
): WorkflowRun[] {
  const incomingIds = new Set(incoming.map((run) => run.id))
  const currentById = new Map(current.map((run) => [run.id, run]))
  const concurrent = current.filter((run) =>
    concurrentRunIds.has(run.id)
    || (!incomingIds.has(run.id) && !["completed", "failed", "cancelled"].includes(run.status)))
  const listRuns = incoming.filter((run) => {
    const existing = currentById.get(run.id)
    return !concurrentRunIds.has(run.id) || !existing || compareWorkflowRuns(run, existing) > 0
  })
  return reconcileWorkflowRuns(concurrent, listRuns)
}
