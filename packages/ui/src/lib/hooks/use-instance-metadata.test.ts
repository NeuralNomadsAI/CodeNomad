import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { extractConfiguredPlugins } from "./plugin-metadata.ts"

describe("extractConfiguredPlugins", () => {
  it("normalizes string plugin entries", () => {
    assert.deepEqual(extractConfiguredPlugins(["npm:user-plugin", "file:///tmp/plugin.ts"]), [
      "npm:user-plugin",
      "/tmp/plugin.ts",
    ])
  })

  it("reads tuple plugin specifiers without crashing", () => {
    assert.deepEqual(
      extractConfiguredPlugins([
        ["@neuralnomads/nomadworks", { onboarding: "auto" }],
        ["file:///tmp/plugin.ts", { enabled: true }],
      ]),
      ["@neuralnomads/nomadworks", "/tmp/plugin.ts"],
    )
  })

  it("ignores invalid plugin entry shapes", () => {
    assert.deepEqual(
      extractConfiguredPlugins([
        [123, { invalid: true }],
        { plugin: "bad" },
        ["npm:good-plugin", { ok: true }],
      ]),
      ["npm:good-plugin"],
    )
  })

  it("returns an empty list for non-array plugin config", () => {
    assert.deepEqual(extractConfiguredPlugins(undefined), [])
    assert.deepEqual(extractConfiguredPlugins("npm:user-plugin"), [])
  })
})
