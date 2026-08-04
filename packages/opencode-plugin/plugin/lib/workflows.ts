import { tool } from "@opencode-ai/plugin/tool"
import { createCodeNomadRequester, type CodeNomadConfig } from "./request.js"

type WorkflowStatus =
  | "running"
  | "pausing"
  | "paused"
  | "waiting_for_review"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "recovery_required"

type WorkflowUsage = {
  cost: number
  tokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

type WorkflowRun = {
  id: string
  objective: string
  status: WorkflowStatus
  error?: string
  pendingReviewStepId?: string
  definitionId?: string
  definitionRevision?: number
  steps: Array<{
    id: string
    title: string
    status: string
    sessionId?: string
    output?: unknown
    outputTruncated?: boolean
  }>
  executionNodes?: Array<{
    instanceKey: string
    status: string
    sessionIds?: string[]
    error?: string
    outputTruncated?: boolean
    usage?: WorkflowUsage
  }>
  pendingGate?: {
    executionNodeId: string
    gate: "approval" | "input"
    prompt: string
    inputSchema?: Record<string, unknown>
  }
  usage?: WorkflowUsage
}

type WorkflowDefinitionRecord = {
  id: string
  revision: number
  definition: {
    name: string
    description?: string
  }
  canonical: string
}

const JSON_VALUE_BYTES_LIMIT = 256_000
const JSON_VALUE_DEPTH_LIMIT = 20
const JSON_VALUE_COUNT_LIMIT = 50_000

function summarize(run: WorkflowRun) {
  const dynamic = Boolean(run.definitionId || run.executionNodes)
  const progress = dynamic
    ? summarizeExecution(run)
    : run.steps.map((step) => `${step.title}: ${step.status}${step.sessionId ? ` (${step.sessionId})` : ""}`).join("\n")
  const guidance = statusGuidance(run.status)
  return [
    `Workflow ${run.id}`,
    `Status: ${run.status}`,
    progress,
    guidance,
    dynamic ? describePendingGate(run) : "",
    run.error ? `Error: ${run.error}` : "",
  ].filter(Boolean).join("\n")
}

function details(run: WorkflowRun) {
  if (run.definitionId || run.executionNodes) {
    const nodes = (run.executionNodes ?? []).map((node) => {
      const sessions = node.sessionIds?.length ? ` (${node.sessionIds.join(", ")})` : ""
      const usage = node.usage ? ` | ${node.usage.tokens} tokens, cost ${node.usage.cost}` : ""
      const error = node.error ? ` | error: ${node.error}` : ""
      const truncated = node.outputTruncated ? " | output truncated; inspect the session in CodeNomad" : ""
      return `${node.instanceKey}: ${node.status}${sessions}${usage}${error}${truncated}`
    })
    return [summarize(run), nodes.length ? `Execution details:\n${nodes.join("\n")}` : ""].filter(Boolean).join("\n")
  }
  const reviewed = run.steps.find((step) => step.id === run.pendingReviewStepId)
  const output = reviewed?.output === undefined ? "" : `\nPending review:\n${JSON.stringify(reviewed.output, null, 2)}`
  const truncated = reviewed?.outputTruncated
    ? `\nThis output is truncated. Review the full generated session${reviewed.sessionId ? ` ${reviewed.sessionId}` : ""} before approval.`
    : ""
  return `${summarize(run)}${output}${truncated}`
}

export const describeWorkflowDetails = details

export function parseWorkflowInputs(value?: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (Buffer.byteLength(value, "utf8") > JSON_VALUE_BYTES_LIMIT) {
    throw new Error("Workflow inputs are too large.")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("Workflow inputs must be valid JSON.")
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Workflow inputs must be a JSON object.")
  }
  const issue = inspectJsonValue(parsed)
  if (issue) throw new Error(`Workflow inputs ${issue}.`)
  return parsed as Record<string, unknown>
}

function inspectJsonValue(input: unknown): string | undefined {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]
  const seen = new WeakSet<object>()
  let count = 0

  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++count > JSON_VALUE_COUNT_LIMIT) return "contain too many values"
    if (depth > JSON_VALUE_DEPTH_LIMIT) return "are too deeply nested"
    if (value === null || typeof value === "string" || typeof value === "boolean") continue
    if (typeof value === "number" && Number.isFinite(value)) continue
    if (!value || typeof value !== "object") return "must contain only JSON values"
    if (seen.has(value)) return "must not contain cycles or aliases"
    seen.add(value)

    if (Array.isArray(value)) {
      const keys = Object.keys(value)
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        return "must contain only plain JSON arrays"
      }
      for (let index = value.length - 1; index >= 0; index--) {
        pending.push({ value: value[index], depth: depth + 1 })
      }
      continue
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return "must contain only plain JSON objects"
    for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 })
  }
}

function summarizeExecution(run: WorkflowRun) {
  const nodes = run.executionNodes ?? []
  const counts = new Map<string, number>()
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1)
  const statuses = [...counts].map(([status, count]) => `${status}: ${count}`).join(", ")
  const identity = `Definition: ${run.definitionId ?? "unknown"}${run.definitionRevision ? ` revision ${run.definitionRevision}` : ""}`
  const execution = `Execution nodes: ${nodes.length} total${statuses ? ` (${statuses})` : ""}`
  const usage = run.usage
    ? `Usage: ${run.usage.tokens} tokens (input ${run.usage.inputTokens}, output ${run.usage.outputTokens}, reasoning ${run.usage.reasoningTokens}, cache read ${run.usage.cacheReadTokens}, cache write ${run.usage.cacheWriteTokens}); cost ${run.usage.cost}`
    : "Usage: unavailable"
  return `${identity}\n${execution}\n${usage}`
}

function statusGuidance(status: WorkflowStatus) {
  if (status === "waiting_for_review") return "Human approval is required in the CodeNomad UI before the workflow can continue or complete; plugin credentials cannot approve it."
  if (status === "waiting_for_input") return "Human input is required in the CodeNomad UI; plugin credentials cannot answer it."
  if (status === "pausing") return "The workflow is pausing. Monitor it in the CodeNomad UI."
  if (status === "paused") return "The workflow is paused. Only a human can resume it in the CodeNomad UI."
  if (status === "recovery_required") return "Recovery confirmation is required from a human in the CodeNomad UI; plugin credentials cannot confirm recovery."
  return ""
}

function describePendingGate(run: WorkflowRun) {
  const gate = run.pendingGate
  if (!gate) return ""
  const action = gate.gate === "approval" ? "Approve or reject" : "Provide the requested input"
  const restriction = gate.gate === "approval" ? "cannot approve this gate" : "cannot answer this gate"
  const schema = gate.inputSchema ? `\nExpected input schema:\n${JSON.stringify(gate.inputSchema, null, 2)}` : ""
  return `Pending ${gate.gate} gate (${gate.executionNodeId}): ${gate.prompt}${schema}\n${action} as a human in the CodeNomad UI; plugin credentials ${restriction}.`
}

export function describeWorkflowDefinitions(definitions: WorkflowDefinitionRecord[]) {
  if (definitions.length === 0) return "No saved CodeNomad workflow definitions found."
  return definitions.map((record) => [
    `${record.id} | revision ${record.revision} | ${record.definition.name}`,
    record.definition.description,
  ].filter(Boolean).join(" | ")).join("\n")
}

export function describeWorkflowDefinition(record: WorkflowDefinitionRecord) {
  return [
    `Workflow definition ${record.id}`,
    `Name: ${record.definition.name}`,
    `Revision: ${record.revision}`,
    record.definition.description ? `Description: ${record.definition.description}` : "",
    `Canonical definition:\n${record.canonical}`,
  ].filter(Boolean).join("\n")
}

type WorkflowRequester = Pick<ReturnType<typeof createCodeNomadRequester>, "requestJson">

export function createWorkflowTools(config: CodeNomadConfig, requester: WorkflowRequester = createCodeNomadRequester(config)) {
  const request = <T>(path: string, init?: RequestInit) => requester.requestJson<T>(`/workflow-runs${path}`, init)
  const requestDefinition = <T>(path: string, init?: RequestInit) => requester.requestJson<T>(`/workflow-definitions${path}`, init)

  return {
    list_codenomad_workflow_definitions: tool({
      description: "List saved workflow definitions available to start at their current revision.",
      args: {},
      async execute() {
        const response = await requestDefinition<{ definitions: WorkflowDefinitionRecord[] }>("")
        return describeWorkflowDefinitions(response.definitions)
      },
    }),
    get_codenomad_workflow_definition: tool({
      description: "Inspect the current revision of a saved workflow definition. This tool cannot inspect historical revisions.",
      args: { definition_id: tool.schema.string().describe("Saved workflow definition ID") },
      async execute(args) {
        const record = await requestDefinition<WorkflowDefinitionRecord>(`/${encodeURIComponent(args.definition_id)}`)
        return describeWorkflowDefinition(record)
      },
    }),
    start_codenomad_workflow_definition: tool({
      description: "Start the current revision of a saved workflow definition. Approval and input gates require a human in the CodeNomad UI.",
      args: {
        definition_id: tool.schema.string().describe("Saved workflow definition ID"),
        objective: tool.schema.string().optional().describe("Optional objective; defaults to the definition name"),
        inputs_json: tool.schema.string().optional().describe("Optional workflow inputs as a JSON object"),
      },
      async execute(args, context) {
        const inputs = parseWorkflowInputs(args.inputs_json)
        const run = await requestDefinition<WorkflowRun>(`/${encodeURIComponent(args.definition_id)}/start`, {
          method: "POST",
          body: JSON.stringify({
            ...(args.objective ? { objective: args.objective } : {}),
            ...(inputs ? { inputs } : {}),
          }),
          signal: context.abort,
        })
        return `${summarize(run)}\nStarted the current saved definition revision. Only a human can manage approval, input, pause/resume, and recovery actions in the CodeNomad UI.`
      },
    }),
    list_codenomad_workflows: tool({
      description: "List workflow runs managed by CodeNomad for this workspace.",
      args: {},
      async execute() {
        const response = await request<{ runs: WorkflowRun[] }>("")
        if (response.runs.length === 0) return "No CodeNomad workflow runs found."
        return response.runs.map((run) => run.definitionId || run.executionNodes
          ? `Objective: ${run.objective}\n${summarize(run)}`
          : `${run.id} | ${run.status} | ${run.objective}`).join("\n\n")
      },
    }),
    get_codenomad_workflow: tool({
      description: "Inspect one CodeNomad workflow run and its role sessions.",
      args: { run_id: tool.schema.string().describe("Workflow run ID") },
      async execute(args) {
        return details(await request<WorkflowRun>(`/${encodeURIComponent(args.run_id)}`))
      },
    }),
    approve_codenomad_workflow: tool({
      description:
        "Show the pending approval details. Only a user in the CodeNomad Workflows panel can approve and continue the workflow.",
      args: { run_id: tool.schema.string().describe("Workflow run ID") },
      async execute(args) {
        const run = await request<WorkflowRun>(`/${encodeURIComponent(args.run_id)}`)
        return `${details(run)}\nApproval was not applied. Ask the user to approve this run in the CodeNomad Workflows panel.`
      },
    }),
    cancel_codenomad_workflow: tool({
      description: "Cancel a running or review-pending CodeNomad workflow.",
      args: { run_id: tool.schema.string().describe("Workflow run ID") },
      async execute(args, context) {
        const run = await request<WorkflowRun>(`/${encodeURIComponent(args.run_id)}/cancel`, { method: "POST", signal: context.abort })
        return summarize(run)
      },
    }),
  }
}
