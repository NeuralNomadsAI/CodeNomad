import { tool } from "@opencode-ai/plugin/tool"
import { createCodeNomadRequester, type CodeNomadConfig } from "./request.js"

type WorkflowStatus = "running" | "waiting_for_review" | "completed" | "failed" | "cancelled" | "interrupted"

type WorkflowRun = {
  id: string
  objective: string
  status: WorkflowStatus
  error?: string
  pendingReviewStepId?: string
  steps: Array<{
    id: string
    title: string
    status: string
    sessionId?: string
    output?: unknown
    outputTruncated?: boolean
  }>
}

function modelConfig(providerID?: string, modelID?: string) {
  if (Boolean(providerID) !== Boolean(modelID)) {
    throw new Error("Provider ID and model ID must be supplied together.")
  }
  return providerID && modelID ? { providerID, modelID } : undefined
}

function summarize(run: WorkflowRun) {
  const steps = run.steps
    .map((step) => `${step.title}: ${step.status}${step.sessionId ? ` (${step.sessionId})` : ""}`)
    .join("\n")
  const review = run.status === "waiting_for_review"
    ? "\nHuman review is required in CodeNomad before the workflow can continue or complete."
    : ""
  return `Workflow ${run.id}\nStatus: ${run.status}\n${steps}${review}${run.error ? `\nError: ${run.error}` : ""}`
}

function details(run: WorkflowRun) {
  const reviewed = run.steps.find((step) => step.id === run.pendingReviewStepId)
  const output = reviewed?.output === undefined ? "" : `\nPending review:\n${JSON.stringify(reviewed.output, null, 2)}`
  const truncated = reviewed?.outputTruncated
    ? `\nThis output is truncated. Review the full generated session${reviewed.sessionId ? ` ${reviewed.sessionId}` : ""} before approval.`
    : ""
  return `${summarize(run)}${output}${truncated}`
}

export const describeWorkflowDetails = details

export function describeWorkflowStart(run: WorkflowRun, hasApprovalGate: boolean) {
  const gateMessage = hasApprovalGate
    ? "The workflow will pause at its configured human approval gates."
    : "This workflow has no human approval gate."
  return `${summarize(run)}\n${gateMessage}`
}

export function createWorkflowTools(config: CodeNomadConfig) {
  const requester = createCodeNomadRequester(config)
  const request = <T>(path: string, init?: RequestInit) => requester.requestJson<T>(`/workflow-runs${path}`, init)

  return {
    start_codenomad_workflow: tool({
      description:
        "Start a host-managed sequential workflow. Stages may require explicit human review before the next stage runs.",
      args: {
        objective: tool.schema.string().describe("The objective for the workflow"),
        stages: tool.schema.array(tool.schema.object({
          id: tool.schema.string().describe("Stable stage ID using letters, numbers, underscore, or dash"),
          title: tool.schema.string().describe("Human-readable stage title"),
          instructions: tool.schema.string().describe("Instructions for this stage"),
          agent: tool.schema.string().optional().describe("Optional OpenCode agent"),
          provider_id: tool.schema.string().optional().describe("Optional model provider ID"),
          model_id: tool.schema.string().optional().describe("Optional model ID"),
          requires_approval: tool.schema.boolean().optional().describe("Pause for human review after this stage"),
        })).min(1).max(12).optional().describe("Ordered workflow stages; defaults to Planner then Implementer"),
      },
      async execute(args, context) {
        const stages = args.stages?.map((stage) => {
          const model = modelConfig(stage.provider_id, stage.model_id)
          return {
            id: stage.id,
            title: stage.title,
            instructions: stage.instructions,
            ...(stage.agent ? { agent: stage.agent } : {}),
            ...(model ? { model } : {}),
            requiresApproval: Boolean(stage.requires_approval),
          }
        }) ?? [
          {
            id: "planner",
            title: "Planner",
            instructions: "Create a concise implementation plan with ordered, verifiable steps.",
            requiresApproval: true,
          },
          {
            id: "implementer",
            title: "Implementer",
            instructions: "Implement the approved plan and run focused validation.",
            requiresApproval: false,
          },
        ]
        const run = await request<WorkflowRun>("", {
          method: "POST",
          body: JSON.stringify({
            objective: args.objective,
            initiatorSessionId: context.sessionID,
            stages,
          }),
        })
        return describeWorkflowStart(run, stages.some((stage) => stage.requiresApproval))
      },
    }),
    list_codenomad_workflows: tool({
      description: "List workflow runs managed by CodeNomad for this workspace.",
      args: {},
      async execute() {
        const response = await request<{ runs: WorkflowRun[] }>("")
        if (response.runs.length === 0) return "No CodeNomad workflow runs found."
        return response.runs.map((run) => `${run.id} | ${run.status} | ${run.objective}`).join("\n")
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
      async execute(args) {
        const run = await request<WorkflowRun>(`/${encodeURIComponent(args.run_id)}/cancel`, { method: "POST" })
        return summarize(run)
      },
    }),
  }
}
