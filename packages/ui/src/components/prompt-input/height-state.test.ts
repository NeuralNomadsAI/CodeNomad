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
    persistPromptInputHeight({ ratio: 0.3 }, (_key, value) => writes.push(value))
    initializePromptInputHeight(() => "999")
    assert.deepEqual(promptInputHeight(), { ratio: 0.3 })
    assert.deepEqual(parsePromptInputHeight(writes[1]), { ratio: 0.3 })
    persistPromptInputHeight(null, (_key, value) => writes.push(value))
    assert.deepEqual(writes, ["320", "ratio:0.3", "auto"])
    assert.equal(promptInputHeight(), null)
  })

  it("rejects malformed stored heights", () => {
    for (const value of ["ratio:", "ratio:NaN", "ratio:Infinity", "ratio:-1", "ratio:0.07", "ratio:0.7"]) {
      assert.equal(parsePromptInputHeight(value), null)
    }
    assert.deepEqual(parsePromptInputHeight("ratio:0.08"), { ratio: 0.08 })
    assert.deepEqual(parsePromptInputHeight("ratio:0.6"), { ratio: 0.6 })
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
