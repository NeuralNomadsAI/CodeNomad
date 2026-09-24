import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { Preferences } from "../../stores/preferences"
import { getCanonicalToolName, getConfigurableToolEntries, getToolRegistryEntry, OTHER_TOOL_NAME, resolveToolVisibility } from "./tool-presentation"

describe("tool presentation registry", () => {
  it("routes OpenCode 2.x tool names to their V1 registry entries", () => {
    assert.equal(getToolRegistryEntry("shell").tool, "bash")
    assert.equal(getToolRegistryEntry("subagent").tool, "task")
    assert.equal(getCanonicalToolName("subagent"), "task")
    assert.equal(getCanonicalToolName("task"), "task")
    assert.equal(getCanonicalToolName("nonexistent"), OTHER_TOOL_NAME)
  })
  it("lists OpenCode 2.x tools in the configurable settings rows", () => {
    const tools = getConfigurableToolEntries().map((entry) => entry.tool)
    for (const tool of ["bash", "read", "edit", "write", "patch", "glob", "grep", "webfetch", "websearch", "execute", "task", "skill", "question", OTHER_TOOL_NAME]) {
      assert.ok(tools.includes(tool), tool)
    }
    for (const tool of ["apply_patch", "todowrite"]) {
      assert.ok(!tools.includes(tool), tool)
    }
  })
  it("keeps renderer identities for retired V1 tools", () => {
    assert.equal(getToolRegistryEntry("todowrite").tool, "todowrite")
    assert.equal(getToolRegistryEntry("apply_patch").tool, "apply_patch")
    assert.equal(getToolRegistryEntry("nonexistent").tool, OTHER_TOOL_NAME)
  })
  it("uses Other presets for historical tools instead of their retired defaults", () => {
    for (const preset of ["minimal", "balanced", "detailed", "everything"] as const) {
      const preferences = { toolCallExpansionDefaults: { preset, tools: {} } } as Preferences
      for (const tool of ["todowrite", "apply_patch", "todoread"]) {
        assert.equal(resolveToolVisibility(preferences, tool), resolveToolVisibility(preferences, "other"), `${preset}: ${tool}`)
      }
    }
  })
})
