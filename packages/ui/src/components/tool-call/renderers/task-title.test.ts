import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getToolTitleDetail } from "../utils"
import { describeTaskTitle } from "./task-title"

describe("task titles across the V1 task and V2 subagent tool names", () => {
  it("describes a V1 task call", () => {
    const title = describeTaskTitle({ subagent_type: "explore", description: "Inspect it" }, "task")
    assert.equal(title, "Task[explore] Inspect it")
    assert.equal(getToolTitleDetail(title, "task"), "[explore] Inspect it")
  })

  it("describes a V2 subagent call with the same semantics", () => {
    const title = describeTaskTitle({ agent: "explore", description: "Inspect it" }, "subagent")
    assert.equal(title, "Subagent[explore] Inspect it")
    assert.equal(getToolTitleDetail(title, "subagent"), "[explore] Inspect it")
  })

  it("strips the canonical task label from a subagent header", () => {
    assert.equal(getToolTitleDetail("Task[explore] Inspect it", "subagent"), "[explore] Inspect it")
    assert.equal(getToolTitleDetail("Subagent", "subagent"), "")
  })
})
