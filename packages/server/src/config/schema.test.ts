import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PreferencesSchema } from "./schema"

describe("chat visibility preferences", () => {
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
