import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Preferences } from "../stores/preferences"
import { transcriptVisibility, transcriptVisibilityPatch, transcriptVisibilityRows } from "./transcript-visibility"

const current = () => ({
  showThinkingBlocks: true,
  thinkingBlocksExpansion: "expanded",
  toolOutputExpansion: "expanded",
  diagnosticsExpansion: "collapsed",
  toolInputsVisibility: "hidden",
  showUsageMetrics: true,
  usageMetricsExpansion: "collapsed",
  toolCallExpansionDefaults: { preset: "balanced", tools: {} },
} as Preferences)
const rows = transcriptVisibilityRows((key) => key)
const row = (key: string) => rows.find((item) => item.key === key)!

describe("shared transcript visibility controls", () => {
  it("hides system messages for older preferences and changes them independently", () => {
    assert.equal(transcriptVisibility(current(), row("system")), "hidden")
    for (const mode of ["hidden", "collapsed", "expanded"] as const) {
      assert.deepEqual(transcriptVisibilityPatch(current(), row("system"), mode), { systemMessagesVisibility: mode })
    }
  })
  it("uses dev's order and label keys in both preferences and the popup", () => {
    assert.deepEqual(rows.slice(0, 5), [
      { kind: "thinking", key: "thinking", label: "settings.behavior.expansionDefaults.thinking" },
      { kind: "diagnostics", key: "diagnostics", label: "settings.behavior.diagnosticsDefault.title" },
      { kind: "inputs", key: "inputs", label: "settings.behavior.toolInputsVisibility.title" },
      { kind: "usage", key: "usage", label: "settings.behavior.usageMetrics.title" },
      { kind: "system", key: "system", label: "transcriptFilters.systemMessages" },
    ])
    assert.ok(rows.slice(5).every((item) => item.kind === "tool"))
  })
  it("preserves every other effective tool setting when customizing one tool", () => {
    const before = current()
    const after = { ...before, ...transcriptVisibilityPatch(before, row("read"), "hidden") }
    assert.equal(after.toolCallExpansionDefaults.preset, "custom")
    assert.equal(transcriptVisibility(after, row("read")), "hidden")
    for (const item of rows.filter((item) => item.key !== "read")) {
      assert.equal(transcriptVisibility(after, item), transcriptVisibility(before, item), item.key)
    }
  })
  it("keeps overrides for registered tools that are hidden from the settings list", () => {
    const before = current()
    before.toolCallExpansionDefaults = {
      preset: "custom",
      thinking: "expanded",
      tools: { apply_patch: "hidden", todowrite: "expanded", read: "collapsed", other: "collapsed" },
    }
    assert.ok(!rows.some((item) => item.key === "apply_patch" || item.key === "todowrite"))
    const after = { ...before, ...transcriptVisibilityPatch(before, row("read"), "expanded") }
    assert.equal(after.toolCallExpansionDefaults.tools.read, "expanded")
    assert.equal(after.toolCallExpansionDefaults.tools.apply_patch, "hidden")
    assert.equal(after.toolCallExpansionDefaults.tools.todowrite, "expanded")
    assert.equal(transcriptVisibility(after, { kind: "tool", key: "apply_patch", label: "" }), "hidden")
    assert.equal(transcriptVisibility(after, { kind: "tool", key: "todowrite", label: "" }), "expanded")
  })
  it("supports all three tool modes", () => {
    for (const mode of ["hidden", "collapsed", "expanded"] as const) {
      const before = current()
      const after = { ...before, ...transcriptVisibilityPatch(before, row("bash"), mode) }
      assert.equal(transcriptVisibility(after, row("bash")), mode)
    }
  })
  it("hides thinking without discarding its expansion preference", () => {
    const before = current()
    before.toolCallExpansionDefaults.thinking = "expanded"
    const after = { ...before, ...transcriptVisibilityPatch(before, row("thinking"), "hidden") }
    assert.equal(transcriptVisibility(after, row("thinking")), "hidden")
    assert.equal(after.toolCallExpansionDefaults.thinking, "expanded")
  })
  it("keeps usage expansion when hiding metrics", () => {
    assert.deepEqual(transcriptVisibilityPatch(current(), row("usage"), "hidden"), {
      showUsageMetrics: false, usageMetricsExpansion: "collapsed",
    })
  })
  it("updates diagnostics and inputs independently", () => {
    assert.deepEqual(transcriptVisibilityPatch(current(), row("diagnostics"), "hidden"), { diagnosticsExpansion: "hidden" })
    assert.deepEqual(transcriptVisibilityPatch(current(), row("inputs"), "expanded"), { toolInputsVisibility: "expanded" })
  })
})
