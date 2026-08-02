import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { formatLaunchErrorMessage } from "./launch-errors"

describe("formatLaunchErrorMessage", () => {
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
