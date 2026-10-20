import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { normalizeToolCallExpansionDefaults, type Preferences } from "../stores/preferences"
import {
  TRANSCRIPT_PRESETS,
  transcriptPreset,
  transcriptPresetPatch,
  transcriptVisibility,
  transcriptVisibilityPatch,
  transcriptVisibilityRows,
} from "./transcript-visibility"

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
  it("routes retired tools through Other even with conflicting saved overrides", () => {
    const before = current()
    before.toolCallExpansionDefaults = {
      preset: "custom",
      thinking: "expanded",
      tools: { apply_patch: "hidden", todowrite: "expanded", read: "collapsed", other: "collapsed" },
    }
    assert.ok(!rows.some((item) => item.key === "apply_patch" || item.key === "todowrite"))
    const after = { ...before, ...transcriptVisibilityPatch(before, row("read"), "expanded") }
    assert.equal(after.toolCallExpansionDefaults.tools.read, "expanded")
    assert.equal(after.toolCallExpansionDefaults.tools.apply_patch, undefined)
    assert.equal(after.toolCallExpansionDefaults.tools.todowrite, undefined)
    for (const mode of ["hidden", "collapsed", "expanded"] as const) {
      const customized = { ...before, ...transcriptVisibilityPatch(before, row("other"), mode) }
      for (const key of ["apply_patch", "todowrite", "todoread"]) {
        const historical = { kind: "tool" as const, key, label: "" }
        assert.equal(transcriptVisibility(before, historical), "collapsed", key)
        assert.equal(transcriptVisibility(after, historical), "collapsed", key)
        assert.equal(transcriptVisibility(customized, historical), mode, key)
      }
      assert.equal(transcriptVisibility(customized, row("read")), "collapsed")
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
  it("offers Nothing first and no Detailed preset", () => {
    assert.deepEqual(TRANSCRIPT_PRESETS, ["nothing", "minimal", "balanced", "everything"])
  })
  it("recognizes each applied preset until one row changes", () => {
    for (const preset of TRANSCRIPT_PRESETS) {
      const applied = { ...current(), ...transcriptPresetPatch(preset) }
      assert.equal(transcriptPreset(applied), preset)
      for (const item of rows) {
        const mode = transcriptVisibility(applied, item) === "hidden" ? "collapsed" : "hidden"
        assert.equal(transcriptPreset({ ...applied, ...transcriptVisibilityPatch(applied, item, mode) }), "custom", `${preset}: ${item.key}`)
      }
    }
  })
  it("hides every message-content row with Nothing", () => {
    const applied = { ...current(), ...transcriptPresetPatch("nothing") }
    for (const item of rows) assert.equal(transcriptVisibility(applied, item), "hidden", item.key)
  })
  it("keeps a saved Detailed choice as Custom with the same effective tools", () => {
    const saved = { preset: "detailed", thinking: "expanded", tools: { bash: "expanded", read: "collapsed", other: "expanded" } }
    assert.deepEqual(normalizeToolCallExpansionDefaults(saved, {}), {
      preset: "custom", thinking: "expanded", tools: { other: "expanded", read: "collapsed", skill: "collapsed", invalid: "collapsed", bash: "expanded" },
    })
    // Saves from before a tool existed keep Detailed's column for it.
    const older = { ...current(), toolCallExpansionDefaults: normalizeToolCallExpansionDefaults({ preset: "detailed", tools: {} }, {}) }
    assert.equal(transcriptVisibility(older, row("skill")), "collapsed")
    assert.equal(transcriptVisibility(older, row("execute")), "expanded")
    // A missing thinking choice keeps the same legacy fallback as before.
    assert.equal(older.toolCallExpansionDefaults.thinking, "collapsed")
  })
  it("updates diagnostics and inputs independently", () => {
    assert.deepEqual(transcriptVisibilityPatch(current(), row("diagnostics"), "hidden"), { diagnosticsExpansion: "hidden" })
    assert.deepEqual(transcriptVisibilityPatch(current(), row("inputs"), "expanded"), { toolInputsVisibility: "expanded" })
  })
})
