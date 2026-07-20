import assert from "node:assert/strict"
import test from "node:test"
import { describeWorkflowDetails, describeWorkflowStart } from "./workflows.js"

const run = {
  id: "run",
  objective: "Ship it",
  status: "running" as const,
  steps: [{ id: "build", title: "Build", status: "pending" }],
}

test("workflow start message reflects whether a human gate is configured", () => {
  assert.match(describeWorkflowStart(run, true), /will pause/)
  assert.match(describeWorkflowStart(run, false), /no human approval gate/)
})

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
