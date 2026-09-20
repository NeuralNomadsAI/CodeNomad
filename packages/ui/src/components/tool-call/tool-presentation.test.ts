import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getConfigurableToolEntries, getToolRegistryEntry, OTHER_TOOL_NAME } from "./tool-presentation"

describe("tool presentation registry", () => {
  it("routes OpenCode 2.x tool names to their V1 registry entries", () => {
    assert.equal(getToolRegistryEntry("shell").tool, "bash")
    assert.equal(getToolRegistryEntry("subagent").tool, "task")
  })
  it("lists OpenCode 2.x tools in the configurable settings rows", () => {
    const tools = getConfigurableToolEntries().map((entry) => entry.tool)
    for (const tool of ["bash", "read", "edit", "write", "glob", "grep", "webfetch", "websearch", "execute", "task", "skill", "question", OTHER_TOOL_NAME]) {
      assert.ok(tools.includes(tool), tool)
    }
    for (const tool of ["patch", "apply_patch", "todowrite"]) {
      assert.ok(!tools.includes(tool), tool)
    }
  })
  it("keeps rendering defaults for retired V1 tools", () => {
    assert.equal(getToolRegistryEntry("todowrite").tool, "todowrite")
    assert.equal(getToolRegistryEntry("apply_patch").tool, "apply_patch")
    assert.equal(getToolRegistryEntry("nonexistent").tool, OTHER_TOOL_NAME)
  })
})
