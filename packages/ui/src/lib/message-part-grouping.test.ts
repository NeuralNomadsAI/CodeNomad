import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { groupTechnicalParts, segmentExplorationItems } from "./message-part-grouping.ts"
import type { ClientPart } from "../types/message.ts"

const part = (id: string, type: ClientPart["type"], tool?: string) => ({ id, type, ...(tool ? { tool } : {}) }) as ClientPart

describe("message technical part grouping", () => {
  it("matches the TUI reasoning and exploration boundaries", () => {
    const groups = groupTechnicalParts([
      part("r1", "reasoning"),
      part("r2", "reasoning"),
      part("read", "tool", "Read"),
      part("grep", "tool", "grep"),
      part("bash", "tool", "bash"),
      part("glob", "tool", "glob"),
      part("text", "text"),
      part("r3", "reasoning"),
    ])

    assert.deepEqual(groups.map((group) => group.kind === "part"
      ? [group.kind, group.part.id]
      : [group.kind, group.parts.map((item) => item.id)]), [
      ["reasoning", ["r1", "r2"]],
      ["exploration", ["read", "grep"]],
      ["part", "bash"],
      ["exploration", ["glob"]],
      ["part", "text"],
      ["reasoning", ["r3"]],
    ])
  })

  it("keeps pending exploration tools in place and splits surrounding groups", () => {
    const segments = segmentExplorationItems(["read", "grep", "glob"], (item) => item === "grep")

    assert.deepEqual(segments, [
      { kind: "group", items: ["read"] },
      { kind: "pending", item: "grep" },
      { kind: "group", items: ["glob"] },
    ])
  })
})
