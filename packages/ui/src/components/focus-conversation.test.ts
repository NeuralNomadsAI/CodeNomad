import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { focusConversationStream } from "./focus-conversation.ts"

describe("focusConversationStream", () => {
  it("focuses the message stream without scrolling", () => {
    const calls: Array<FocusOptions | undefined> = []
    const stream = {
      focus(options?: FocusOptions) {
        calls.push(options)
      },
    } as unknown as HTMLElement
    const root = { querySelector: () => stream } as unknown as ParentNode

    assert.equal(focusConversationStream(root), true)
    assert.deepEqual(calls, [{ preventScroll: true }])
  })

  it("falls back when focus options are unsupported", () => {
    const calls: Array<FocusOptions | undefined> = []
    const stream = {
      focus(options?: FocusOptions) {
        calls.push(options)
        if (options) throw new Error("unsupported")
      },
    } as unknown as HTMLElement
    const root = { querySelector: () => stream } as unknown as ParentNode

    assert.equal(focusConversationStream(root), true)
    assert.deepEqual(calls, [{ preventScroll: true }, undefined])
  })

  it("returns false when focus is unavailable", () => {
    assert.equal(focusConversationStream(null), false)
    const root = { querySelector: () => null } as unknown as ParentNode
    assert.equal(focusConversationStream(root), false)
  })
})
