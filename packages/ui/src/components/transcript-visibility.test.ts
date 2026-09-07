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
  it("preserves every other effective tool setting when customizing one tool", () => {
    const before = current()
    const after = { ...before, ...transcriptVisibilityPatch(before, row("read"), "hidden") }
    assert.equal(after.toolCallExpansionDefaults.preset, "custom")
    assert.equal(transcriptVisibility(after, row("read")), "hidden")
    for (const item of rows.filter((item) => item.key !== "read")) {
      assert.equal(transcriptVisibility(after, item), transcriptVisibility(before, item), item.key)
    }
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
