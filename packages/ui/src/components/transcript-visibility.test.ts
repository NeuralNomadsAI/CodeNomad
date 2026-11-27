import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { normalizeToolCallExpansionDefaults, type Preferences } from "../stores/preferences"
import {
  TRANSCRIPT_PRESETS,
  transcriptCustomAvailable,
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
  toolGroupVisibility: "collapsed",
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
    assert.deepEqual(rows.slice(0, 6), [
      { kind: "thinking", key: "thinking", label: "settings.behavior.expansionDefaults.thinking" },
      { kind: "diagnostics", key: "diagnostics", label: "settings.behavior.diagnosticsDefault.title" },
      { kind: "inputs", key: "inputs", label: "settings.behavior.toolInputsVisibility.title" },
      { kind: "usage", key: "usage", label: "settings.behavior.usageMetrics.title" },
      { kind: "system", key: "system", label: "transcriptFilters.systemMessages" },
      { kind: "toolGroups", key: "toolGroups", label: "transcriptFilters.toolGroups" },
    ])
    assert.ok(rows.slice(6).every((item) => item.kind === "tool"))
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
  it("keeps the Custom rows a preset replaces and applies them again with Custom", () => {
    const balanced = { ...current(), ...transcriptPresetPatch("balanced") }
    assert.equal(transcriptCustomAvailable(balanced), false)
    assert.deepEqual(transcriptPresetPatch("custom", balanced), {})
    // A detail row alone leaves the saved tool preset in place; the kept rows are explicit either way.
    for (const changes of [["read", "diagnostics"], ["diagnostics"]]) {
      let custom = balanced
      for (const key of changes) custom = { ...custom, ...transcriptVisibilityPatch(custom, row(key), "hidden") }
      const replaced = { ...custom, ...transcriptPresetPatch("everything", custom) }
      assert.equal(transcriptPreset(replaced), "everything")
      assert.equal(transcriptCustomAvailable(replaced), true)
      assert.equal(replaced.transcriptCustomPreset?.toolCallExpansionDefaults.preset, "custom")
      // Another preset leaves the kept rows alone.
      assert.equal("transcriptCustomPreset" in transcriptPresetPatch("minimal", replaced), false)
      const restored = { ...replaced, ...transcriptPresetPatch("custom", replaced) }
      assert.equal(transcriptPreset(restored), "custom")
      for (const item of rows) assert.equal(transcriptVisibility(restored, item), transcriptVisibility(custom, item), item.key)
      assert.deepEqual(transcriptPresetPatch("custom", restored), {})
    }
  })
  it("hides every content row with Nothing and expands groups only with Everything", () => {
    const applied = { ...current(), ...transcriptPresetPatch("nothing") }
    for (const item of rows.filter((item) => item.kind !== "toolGroups")) {
      assert.equal(transcriptVisibility(applied, item), "hidden", item.key)
    }
    for (const preset of TRANSCRIPT_PRESETS) {
      const settings = { ...current(), ...transcriptPresetPatch(preset) }
      assert.equal(transcriptVisibility(settings, row("toolGroups")), preset === "everything" ? "expanded" : "collapsed")
    }
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
