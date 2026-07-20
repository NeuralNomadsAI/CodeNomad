import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowRun } from "../../../server/src/api-types.ts"
import {
  WORKFLOW_CLIENT_HISTORY_LIMIT,
  reconcileWorkflowRunList,
  reconcileWorkflowRuns,
} from "./workflow-reconciliation.ts"

const run = (id: string, updatedAt: string, status: WorkflowRun["status"]): WorkflowRun => ({
  id,
  workspaceId: "workspace",
  workspaceLineageId: "lineage",
  workspacePath: "/workspace",
  objective: id,
  status,
  steps: [],
  createdAt: updatedAt,
  updatedAt,
})

test("workflow reconciliation keeps the newest run update and sorts newest first", () => {
  const current = [run("same", "2026-07-20T12:00:00.000Z", "completed")]
  const incoming = [
    run("older-list-entry", "2026-07-20T10:00:00.000Z", "completed"),
    run("same", "2026-07-20T11:00:00.000Z", "running"),
  ]

  const reconciled = reconcileWorkflowRuns(current, incoming)
  assert.deepEqual(reconciled.map(({ id }) => id), ["same", "older-list-entry"])
  assert.equal(reconciled[0].status, "completed")
})

test("workflow reconciliation caps history and removes absent terminal runs without losing concurrent updates", () => {
  const many = Array.from({ length: WORKFLOW_CLIENT_HISTORY_LIMIT + 5 }, (_, index) =>
    run(`run-${index}`, new Date(1_700_000_000_000 + index).toISOString(), "completed"))
  assert.equal(reconcileWorkflowRuns([], many).length, WORKFLOW_CLIENT_HISTORY_LIMIT)

  const staleTerminal = run("stale", "2026-07-20T11:00:00.000Z", "completed")
  const concurrent = run("concurrent", "2026-07-20T10:00:00.000Z", "completed")
  const active = run("active", "2026-07-20T11:00:00.000Z", "waiting_for_review")
  const reconciled = reconcileWorkflowRunList(
    [staleTerminal, concurrent, active],
    [run("concurrent", concurrent.updatedAt, "running")],
    new Set(["concurrent"]),
  )
  assert.deepEqual(reconciled.map(({ id }) => id), ["active", "concurrent"])
})
