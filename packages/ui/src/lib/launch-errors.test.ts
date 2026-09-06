import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { formatLaunchErrorMessage } from "./launch-errors"

describe("formatLaunchErrorMessage", () => {
  it("localizes incompatible OpenCode V1 binary errors", () => {
    assert.equal(
      formatLaunchErrorMessage(
        "opencode_v2_required: Host binary does not support the OpenCode V2 service lifecycle",
        "fallback",
        "Invalid configuration",
        "Select an OpenCode V2 binary",
      ),
      "Select an OpenCode V2 binary",
    )
  })

  it("does not hide unrelated diagnostics mentioning the compatibility marker", () => {
    for (const raw of [
      "ENOENT: /tmp/opencode_v2_required/opencode2",
      "Connection failed: opencode_v2_required is a log filename",
    ]) {
      assert.equal(formatLaunchErrorMessage(raw, "fallback", "Invalid config", "Select V2"), raw)
    }
    const config = JSON.stringify({ name: "ConfigInvalidError", data: { path: "/tmp/opencode_v2_required/config.json" } })
    assert.equal(formatLaunchErrorMessage(config, "fallback", "Invalid config", "Select V2"), "Invalid config\n/tmp/opencode_v2_required/config.json")
  })

  it("localizes compatibility codes transported by JSON API errors", () => {
    const raw = new Error(JSON.stringify({ error: "opencode_v2_required: Host binary does not support V2" }))
    assert.equal(formatLaunchErrorMessage(raw, "fallback", "Invalid config", "Select V2"), "Select V2")
  })

  it("formats OpenCode configuration validation details", () => {
    const error = new Error(JSON.stringify({
      name: "ConfigInvalidError",
      data: {
        path: "C:\\Users\\dev\\.config\\opencode\\agents\\invalid.md",
        issues: [
          { path: ["tools", "bash"], message: 'Expected boolean, got "ask"' },
          { path: ["tools", "webfetch"], message: 'Expected boolean, got "ask"' },
        ],
      },
    }))

    assert.equal(formatLaunchErrorMessage(error, "fallback", "OpenCode configuration is invalid"), [
      "OpenCode configuration is invalid",
      "C:\\Users\\dev\\.config\\opencode\\agents\\invalid.md",
      'tools.bash: Expected boolean, got "ask"',
      'tools.webfetch: Expected boolean, got "ask"',
    ].join("\n"))
  })

  it("preserves message-only tagged configuration errors", () => {
    const error = JSON.stringify({
      _tag: "ConfigInvalidError",
      path: "/home/dev/.config/opencode/opencode.json",
      message: "Missing environment variable",
    })

    assert.equal(formatLaunchErrorMessage(error, "fallback", "Invalid configuration"), [
      "Invalid configuration",
      "/home/dev/.config/opencode/opencode.json",
      "Missing environment variable",
    ].join("\n"))
  })

  it("preserves configuration directory typo suggestions", () => {
    const error = JSON.stringify({
      name: "ConfigDirectoryTypoError",
      data: { dir: "/project/.opencod", suggestion: "/project/.opencode" },
    })

    assert.equal(formatLaunchErrorMessage(error, "fallback", "Invalid configuration"), [
      "Invalid configuration",
      "/project/.opencod → /project/.opencode",
    ].join("\n"))
  })
})
