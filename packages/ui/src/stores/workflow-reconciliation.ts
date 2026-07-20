import type { WorkflowRun } from "../../../server/src/api-types"

const updatedAt = (run: WorkflowRun) => Date.parse(run.updatedAt) || 0
export const WORKFLOW_CLIENT_HISTORY_LIMIT = 100

export function reconcileWorkflowRuns(current: WorkflowRun[], incoming: WorkflowRun[]): WorkflowRun[] {
  const byId = new Map(current.map((run) => [run.id, run]))
  for (const run of incoming) {
    const existing = byId.get(run.id)
    if (!existing || updatedAt(run) >= updatedAt(existing)) byId.set(run.id, run)
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
    || (!incomingIds.has(run.id) && (run.status === "running" || run.status === "waiting_for_review")))
  const listRuns = incoming.filter((run) => {
    const existing = currentById.get(run.id)
    return !concurrentRunIds.has(run.id) || !existing || updatedAt(run) > updatedAt(existing)
  })
  return reconcileWorkflowRuns(concurrent, listRuns)
}
