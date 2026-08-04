import assert from "node:assert/strict"
import test from "node:test"
import {
  createWorkflowTools,
  describeWorkflowDefinition,
  describeWorkflowDefinitions,
  describeWorkflowDetails,
  parseWorkflowInputs,
} from "./workflows.js"

const run = {
  id: "run",
  objective: "Ship it",
  status: "running" as const,
  steps: [{ id: "build", title: "Build", status: "pending" }],
}

test("workflow review messaging handles final and truncated gates", () => {
  const waiting = {
    ...run,
    status: "waiting_for_review" as const,
    pendingReviewStepId: "build",
    steps: [{
      id: "build",
      title: "Build",
      status: "completed",
      sessionId: "session-1",
      output: "partial",
      outputTruncated: true,
    }],
  }
  const details = describeWorkflowDetails(waiting)
  assert.match(details, /continue or complete/)
  assert.match(details, /truncated/)
  assert.match(details, /session-1/)
})

test("dynamic workflow details include execution progress, usage, statuses, and gate guidance", () => {
  const dynamic = {
    id: "dynamic-run",
    objective: "Deploy",
    status: "waiting_for_input" as const,
    definitionId: "deploy",
    definitionRevision: 3,
    steps: [],
    executionNodes: [
      { instanceKey: "plan", status: "completed", sessionIds: ["session-1"] },
      { instanceKey: "environment", status: "waiting" },
    ],
    pendingGate: {
      executionNodeId: "gate-execution-id",
      gate: "input" as const,
      prompt: "Choose an environment",
      inputSchema: { type: "string", enum: ["staging", "production"] },
    },
    usage: {
      cost: 0.25,
      tokens: 120,
      inputTokens: 70,
      outputTokens: 40,
      reasoningTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
    },
  }
  const message = describeWorkflowDetails(dynamic)
  assert.match(message, /Status: waiting_for_input/)
  assert.match(message, /Execution nodes: 2 total \(completed: 1, waiting: 1\)/)
  assert.match(message, /Usage: 120 tokens/)
  assert.match(message, /Choose an environment/)
  assert.match(message, /Expected input schema/)
  assert.match(message, /human in the CodeNomad UI/)
  assert.match(message, /cannot answer this gate/)
  assert.match(message, /session-1/)

  const approval = describeWorkflowDetails({
    ...dynamic,
    status: "waiting_for_review",
    pendingGate: { ...dynamic.pendingGate, gate: "approval" },
  })
  assert.match(approval, /cannot approve this gate/)

  for (const status of ["pausing", "paused", "recovery_required"] as const) {
    assert.match(describeWorkflowDetails({ ...dynamic, status, pendingGate: undefined }), new RegExp(`Status: ${status}`))
    assert.match(describeWorkflowDetails({ ...dynamic, status, pendingGate: undefined }), /CodeNomad UI/)
  }
})

test("saved workflow definition messages expose current revision and canonical definition", () => {
  const definition = {
    id: "deploy",
    revision: 3,
    definition: { name: "Deploy", description: "Deploy safely" },
    canonical: '{"version":1,"id":"deploy"}',
  }
  assert.match(describeWorkflowDefinitions([definition]), /deploy \| revision 3 \| Deploy \| Deploy safely/)
  assert.match(describeWorkflowDefinition(definition), /Canonical definition:\n\{"version":1/)
  assert.equal(describeWorkflowDefinitions([]), "No saved CodeNomad workflow definitions found.")
})

test("saved workflow inputs require a JSON object", () => {
  assert.deepEqual(parseWorkflowInputs('{"environment":"staging"}'), { environment: "staging" })
  assert.equal(parseWorkflowInputs(), undefined)
  assert.throws(() => parseWorkflowInputs("not-json"), /valid JSON/)
  assert.throws(() => parseWorkflowInputs("[]"), /JSON object/)
  assert.throws(() => parseWorkflowInputs("null"), /JSON object/)
  let nested: unknown = true
  for (let depth = 0; depth < 21; depth++) nested = { nested }
  assert.throws(() => parseWorkflowInputs(JSON.stringify(nested)), /deeply nested/)
  assert.throws(() => parseWorkflowInputs(JSON.stringify({ values: Array(50_001).fill(null) })), /too many values/)
  assert.throws(() => parseWorkflowInputs(JSON.stringify({ value: "é".repeat(128_001) })), /too large/)
})

test("saved definition tools read and start the current revision without claiming session ancestry", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const definition = {
    id: "deploy_flow",
    revision: 3,
    definition: { name: "Deploy" },
    canonical: '{"version":1}',
  }
  const requester = {
    async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
      calls.push({ path, init })
      if (path.endsWith("/start")) {
        return {
          id: "run-id",
          objective: "Ship it",
          status: "running",
          definitionId: "deploy_flow",
          definitionRevision: 3,
          steps: [],
          executionNodes: [],
        } as T
      }
      if (path === "/workflow-definitions" && !init) return { definitions: [definition] } as T
      return definition as T
    },
  }
  const tools = createWorkflowTools({ instanceId: "workspace", baseUrl: "http://localhost", callbackToken: "callback" }, requester)
  assert.equal("start_codenomad_workflow" in tools, false)

  await tools.list_codenomad_workflow_definitions.execute({}, {} as never)
  await tools.get_codenomad_workflow_definition.execute({ definition_id: "deploy_flow" }, {} as never)
  const started = await tools.start_codenomad_workflow_definition.execute({
    definition_id: "deploy_flow",
    objective: "Ship it",
    inputs_json: '{"environment":"production"}',
  }, { sessionID: "session-1" } as never)

  assert.deepEqual(calls.map((call) => call.path), [
    "/workflow-definitions",
    "/workflow-definitions/deploy_flow",
    "/workflow-definitions/deploy_flow/start",
  ])
  assert.equal(calls[2]?.init?.method, "POST")
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    objective: "Ship it",
    inputs: { environment: "production" },
  })
  assert.match(started, /current saved definition revision/)
  assert.doesNotMatch(String(calls[2]?.init?.body), /definitionRevision|initiatorSessionId/)
})
