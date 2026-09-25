import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  initializePromptInputHeight,
  parsePromptInputHeight,
  persistPromptInputHeight,
  promptInputHeight,
  setPromptInputHeight,
} from "./height-state"

describe("prompt input height state", () => {
  it("survives composer remounts and persists explicit and automatic heights", () => {
    const writes: string[] = []

    initializePromptInputHeight(() => "240")
    assert.equal(promptInputHeight(), 240)

    setPromptInputHeight(320)
    initializePromptInputHeight(() => "999")
    assert.equal(promptInputHeight(), 320)

    persistPromptInputHeight(320, (_key, value) => writes.push(value))
    persistPromptInputHeight(null, (_key, value) => writes.push(value))
    assert.deepEqual(writes, ["320", "auto"])
    assert.equal(promptInputHeight(), null)
  })

  it("rejects malformed stored heights", () => {
    assert.deepEqual([null, "auto", "", "-1", "NaN", "10001"].map(parsePromptInputHeight), [
      null,
      null,
      null,
      null,
      null,
      null,
    ])
  })
})
