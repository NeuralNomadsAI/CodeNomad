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

    assert.equal(formatLaunchErrorMessage(error, "fallback"), [
      "ConfigInvalidError",
      "C:\\Users\\dev\\.config\\opencode\\agents\\invalid.md",
      'tools.bash: Expected boolean, got "ask"',
      'tools.webfetch: Expected boolean, got "ask"',
    ].join("\n"))
  })
})
