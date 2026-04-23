import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { extractMentionTokens, findMentionedVisibleAgents } from "./attachmentPlaceholders.ts"

describe("extractMentionTokens", () => {
  it("keeps punctuation-delimited mentions usable", () => {
    assert.deepEqual(extractMentionTokens("Use @reviewer, then ask (@planner) and finally @writer:"), ["reviewer", "planner", "writer"])
  })
})

describe("findMentionedVisibleAgents", () => {
  it("ignores hidden agents, the current agent, and duplicates", () => {
    const result = findMentionedVisibleAgents(
      "Try @reviewer, then @reviewer again, skip @hidden-agent, and maybe @active-agent.",
      [
        { name: "reviewer", description: "", mode: "primary" },
        { name: "hidden-agent", description: "", mode: "primary", hidden: true },
        { name: "active-agent", description: "", mode: "primary" },
      ],
      "active-agent",
    )

    assert.deepEqual(result, ["reviewer"])
  })
})
