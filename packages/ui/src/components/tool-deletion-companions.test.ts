import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { collectToolDeletionCompanionPartIds } from "./tool-deletion-companions"

function collect(parts: Array<{ id: string; type: string }>, selectedToolPartIds: string[]) {
  const byId = new Map(parts.map((part) => [part.id, part]))
  return collectToolDeletionCompanionPartIds(
    parts.map((part) => part.id),
    (partId) => byId.get(partId),
    new Set(selectedToolPartIds),
  )
}

describe("collectToolDeletionCompanionPartIds", () => {
  it("collects reasoning and step-finish for a selected tool step", () => {
    const result = collect([
      { id: "start", type: "step-start" },
      { id: "reasoning", type: "reasoning" },
      { id: "tool", type: "tool" },
      { id: "finish", type: "step-finish" },
      { id: "text", type: "text" },
    ], ["tool"])

    assert.deepEqual([...result], ["reasoning", "finish"])
  })

  it("keeps shared companions when only one tool in a step is selected", () => {
    const result = collect([
      { id: "reasoning", type: "reasoning" },
      { id: "tool-a", type: "tool" },
      { id: "tool-b", type: "tool" },
      { id: "finish", type: "step-finish" },
    ], ["tool-a"])

    assert.deepEqual([...result], [])
  })

  it("collects shared companions when every tool in the step is selected", () => {
    const result = collect([
      { id: "reasoning", type: "reasoning" },
      { id: "tool-a", type: "tool" },
      { id: "tool-b", type: "tool" },
      { id: "finish", type: "step-finish" },
    ], ["tool-a", "tool-b"])

    assert.deepEqual([...result], ["reasoning", "finish"])
  })

  it("does not collect companions from an unselected adjacent step", () => {
    const result = collect([
      { id: "start-a", type: "step-start" },
      { id: "reasoning-a", type: "reasoning" },
      { id: "tool-a", type: "tool" },
      { id: "finish-a", type: "step-finish" },
      { id: "start-b", type: "step-start" },
      { id: "reasoning-b", type: "reasoning" },
      { id: "tool-b", type: "tool" },
      { id: "finish-b", type: "step-finish" },
    ], ["tool-a"])

    assert.deepEqual([...result], ["reasoning-a", "finish-a"])
  })
})
