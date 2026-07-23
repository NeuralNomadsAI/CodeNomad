import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PreferencesSchema } from "./schema"

describe("chat visibility preferences", () => {
  it("accepts hidden diagnostics and collapsed usage metrics", () => {
    const preferences = PreferencesSchema.parse({
      diagnosticsExpansion: "hidden",
      usageMetricsExpansion: "collapsed",
    })

    assert.equal(preferences.diagnosticsExpansion, "hidden")
    assert.equal(preferences.usageMetricsExpansion, "collapsed")
  })
})
