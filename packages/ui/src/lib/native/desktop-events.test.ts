import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createTerminalErrorNotifier } from "./desktop-events.ts"

describe("createTerminalErrorNotifier", () => {
  it("calls onError once for repeated terminal notifications", () => {
    let errors = 0
    const notifyTerminalError = createTerminalErrorNotifier({
      onError: () => {
        errors += 1
      },
    })

    notifyTerminalError()
    notifyTerminalError()

    assert.equal(errors, 1)
  })
})
