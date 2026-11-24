import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getUserMessageMenuState, isMessageTextStreaming, shouldShowGeneratingPlaceholder } from "./message-status.ts"

describe("isMessageTextStreaming", () => {
  it("treats text as final once the model stream ended, even while the step's tools still run", () => {
    assert.equal(isMessageTextStreaming("streaming", {}), true)
    assert.equal(isMessageTextStreaming("streaming", undefined), true)
    assert.equal(isMessageTextStreaming("streaming", { streamed: 0 }), true)
    assert.equal(isMessageTextStreaming("streaming", { streamed: 1720000000000 }), false)
    assert.equal(isMessageTextStreaming("complete", {}), false)
    assert.equal(isMessageTextStreaming("error", {}), false)
  })
})

describe("shouldShowGeneratingPlaceholder", () => {
  it("never revives a completed empty control record", () => {
    assert.equal(shouldShowGeneratingPlaceholder(false, "assistant", "complete"), false)
    assert.equal(shouldShowGeneratingPlaceholder(false, "assistant", "streaming"), true)
    assert.equal(shouldShowGeneratingPlaceholder(true, "assistant", "streaming"), false)
  })
})

describe("getUserMessageMenuState", () => {
  it("maps sending to queue, then steer, then consumed history", () => {
    assert.equal(getUserMessageMenuState("sending"), "queue")
    assert.equal(getUserMessageMenuState("sent"), "queue")
    assert.equal(getUserMessageMenuState("complete", "queue"), "queue")
    assert.equal(getUserMessageMenuState("complete", "steer"), "steer")
    assert.equal(getUserMessageMenuState("complete"), "history")
    assert.equal(getUserMessageMenuState("error"), "failed")
  })
})
