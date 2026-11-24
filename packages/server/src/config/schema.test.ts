import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { DEFAULT_CONFIG, DEFAULT_CONFIG_YAML, PreferencesSchema } from "./schema"

describe("chat visibility preferences", () => {
  it("defaults message tokens to hidden and preserves saved visibility and expansion", () => {
    assert.equal(PreferencesSchema.parse({}).showUsageMetrics, false)
    assert.equal(DEFAULT_CONFIG.preferences.showUsageMetrics, false)
    assert.equal(DEFAULT_CONFIG_YAML.preferences.showUsageMetrics, false)
    for (const showUsageMetrics of [false, true]) {
      for (const usageMetricsExpansion of ["collapsed", "expanded"] as const) {
        const preferences = PreferencesSchema.parse({ showUsageMetrics, usageMetricsExpansion })
        assert.equal(preferences.showUsageMetrics, showUsageMetrics)
        assert.equal(preferences.usageMetricsExpansion, usageMetricsExpansion)
      }
    }
  })
  it("defaults system messages to hidden and preserves explicit visibility", () => {
    assert.equal(PreferencesSchema.parse({}).systemMessagesVisibility, "hidden")
    for (const mode of ["hidden", "collapsed", "expanded"] as const) {
      assert.equal(PreferencesSchema.parse({ systemMessagesVisibility: mode }).systemMessagesVisibility, mode)
    }
    assert.equal(PreferencesSchema.safeParse({ systemMessagesVisibility: "invalid" }).success, false)
  })
  it("accepts hidden diagnostics and collapsed usage metrics", () => {
    const preferences = PreferencesSchema.parse({
      diagnosticsExpansion: "hidden",
      usageMetricsExpansion: "collapsed",
    })

    assert.equal(preferences.diagnosticsExpansion, "hidden")
    assert.equal(preferences.usageMetricsExpansion, "collapsed")
  })
})
