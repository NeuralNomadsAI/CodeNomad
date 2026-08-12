import type { WorkflowExecutionNode, WorkflowRun } from "../../../../../../../server/src/api-types"
import { ApiRequestError } from "../../../../../lib/api-client"
import type { Instance } from "../../../../../types/instance"

export interface WorkflowExecutionTreeNode {
  node: WorkflowExecutionNode
  children: WorkflowExecutionTreeNode[]
}

export const WORKFLOW_INPUT_BYTES_LIMIT = 64_000
export const WORKFLOW_INPUT_DEPTH_LIMIT = 20
export const WORKFLOW_EXECUTION_NODE_LIMIT = 200

type Translate = (key: string, vars?: Record<string, any>) => string

export function formatWorkflowError(error: unknown, t: Translate): string {
  const status = error instanceof ApiRequestError ? error.status : undefined
  const code = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  if (status === 409 || code === "workflow_definition_stale") return t("instanceShell.workflows.declarative.conflict")
  if (status === 404) return t("instanceShell.workflows.errors.notFound")
  if (status === 503) return t("instanceShell.workflows.errors.unavailable")
  return t("instanceShell.workflows.errors.action")
}

export function formatWorkflowRunTime(value: string, locale: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date)
}

export function resolveWorkflowRunWorkspaceId(run: WorkflowRun, available: ReadonlyMap<string, Instance>): string | undefined {
  if (available.has(run.workspaceId)) return run.workspaceId
  return [...available.values()].find((instance) => instance.lineageId === run.workspaceLineageId && instance.status === "ready")?.id
}

export function buildWorkflowExecutionTree(nodes: WorkflowExecutionNode[]): WorkflowExecutionTreeNode[] {
  const treeNodes = new Map<string, WorkflowExecutionTreeNode>(
    nodes.map((node) => [node.instanceKey, { node, children: [] }]),
  )
  const roots: WorkflowExecutionTreeNode[] = []
  for (const node of nodes) {
    const current = treeNodes.get(node.instanceKey)!
    const parent = node.parentInstanceKey ? treeNodes.get(node.parentInstanceKey) : undefined
    if (parent) parent.children.push(current)
    else roots.push(current)
  }
  return roots
}

export function parseWorkflowObject(source: string): Record<string, unknown> | undefined {
  if (!source.trim()) return undefined
  if (new TextEncoder().encode(source).byteLength > WORKFLOW_INPUT_BYTES_LIMIT) throw new Error("input_too_large")
  const value: unknown = JSON.parse(source)
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("object_required")
  const pending = [{ value, depth: 0 }]
  while (pending.length) {
    const current = pending.pop()!
    if (current.depth > WORKFLOW_INPUT_DEPTH_LIMIT) throw new Error("input_too_deep")
    if (!current.value || typeof current.value !== "object") continue
    for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 })
  }
  return value as Record<string, unknown>
}
