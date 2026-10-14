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

    initializePromptInputHeight("first", () => "240")
    assert.equal(promptInputHeight("first"), 240)

    setPromptInputHeight("first", 320)
    initializePromptInputHeight("first", () => "999")
    assert.equal(promptInputHeight("first"), 320)

    persistPromptInputHeight("first", 320, (_key, value) => writes.push(value))
    persistPromptInputHeight("first", { ratio: 0.3 }, (_key, value) => writes.push(value))
    initializePromptInputHeight("first", () => "999")
    assert.deepEqual(promptInputHeight("first"), { ratio: 0.3 })
    assert.deepEqual(parsePromptInputHeight(writes[1]), { ratio: 0.3 })
    persistPromptInputHeight("first", null, (_key, value) => writes.push(value))
    assert.deepEqual(writes, ["320", "ratio:0.3", "auto"])
    assert.equal(promptInputHeight("first"), null)
  })

  it("keeps each instance's height independent; new instances start from the last saved one", () => {
    const write = () => {}
    initializePromptInputHeight("left")
    initializePromptInputHeight("right")
    persistPromptInputHeight("left", { ratio: 0.4 }, write)
    persistPromptInputHeight("right", { ratio: 0.2 }, write)
    assert.deepEqual(promptInputHeight("left"), { ratio: 0.4 })
    assert.deepEqual(promptInputHeight("right"), { ratio: 0.2 })

    initializePromptInputHeight("later")
    assert.deepEqual(promptInputHeight("later"), { ratio: 0.2 })
    persistPromptInputHeight("left", { ratio: 0.5 }, write)
    assert.deepEqual(promptInputHeight("later"), { ratio: 0.2 }, "an opened instance keeps its pinned height")
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
