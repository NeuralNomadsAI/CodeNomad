import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { MESSAGE_HISTORY_TOP_THRESHOLD_PX, shouldLoadOlderMessages } from "./message-history-pagination.ts"

describe("message history pagination", () => {
  const ready = {
    active: true,
    failed: false,
    hasMore: true,
    loading: false,
    messageCount: 2,
    scrollTop: MESSAGE_HISTORY_TOP_THRESHOLD_PX,
  }

  it("loads at the top threshold", () => {
    assert.equal(shouldLoadOlderMessages(ready), true)
    assert.equal(shouldLoadOlderMessages({ ...ready, scrollTop: MESSAGE_HISTORY_TOP_THRESHOLD_PX + 1 }), false)
  })

  it("guards inactive, exhausted, concurrent, failed, and empty loads", () => {
    assert.equal(shouldLoadOlderMessages({ ...ready, active: false }), false)
    assert.equal(shouldLoadOlderMessages({ ...ready, hasMore: false }), false)
    assert.equal(shouldLoadOlderMessages({ ...ready, loading: true }), false)
    assert.equal(shouldLoadOlderMessages({ ...ready, failed: true }), false)
    assert.equal(shouldLoadOlderMessages({ ...ready, messageCount: 0 }), false)
  })
})
