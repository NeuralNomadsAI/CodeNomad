import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { findUserMessageJumpTarget, keyAllowsUserMessageJump } from "./user-message-navigation"

// u = user, a = assistant text, t = its tools (a separate marker of the same message).
const markers = [
  { messageId: "m1", type: "user" },
  { messageId: "m2", type: "tool" }, { messageId: "m2", type: "assistant" },
  { messageId: "m3", type: "user" },
  { messageId: "m4", type: "assistant" },
  { messageId: "m6", type: "user" },
  { messageId: "m7", type: "assistant" },
]
const resident = ["m3", "m4", "m5", "m6", "m7"]
const jump = (current: string | null, direction: "previous" | "next") =>
  findUserMessageJumpTarget({ markers, resident, current, direction })

describe("user message jumps", () => {
  it("moves strictly before or after the current message, from a prompt or a reply", () => {
    assert.equal(jump("m3", "previous"), "m1")
    assert.equal(jump("m3", "next"), "m6")
    assert.equal(jump("m2", "previous"), "m1", "a reply goes back to its prompt")
    assert.equal(jump("m2", "next"), "m3")
    assert.equal(jump("m7", "previous"), "m6")
  })

  it("stops at both ends", () => {
    assert.equal(jump("m1", "previous"), null)
    assert.equal(jump("m6", "next"), null)
    assert.equal(jump("m7", "next"), null)
  })

  it("places a message without a marker between its resident neighbours", () => {
    assert.equal(jump("m5", "previous"), "m3")
    assert.equal(jump("m5", "next"), "m6")
    assert.equal(findUserMessageJumpTarget({ markers, resident: ["m0", "m1"], current: "m0", direction: "next" }), "m1",
      "only later neighbours are marked")
    assert.equal(findUserMessageJumpTarget({ markers, resident: ["m0", "m1"], current: "m0", direction: "previous" }), null)
  })

  it("starts Previous from the end without a position, where Next finds nothing", () => {
    for (const current of [null, "unknown"]) {
      assert.equal(jump(current, "previous"), "m6")
      assert.equal(jump(current, "next"), null)
    }
    assert.equal(findUserMessageJumpTarget({ markers: [], resident: [], current: null, direction: "previous" }), null)
  })
})

describe("user message jump keys", () => {
  const key = (target: object | null, values: Partial<KeyboardEvent> = {}) =>
    ({ isComposing: false, keyCode: 38, target, ...values }) as unknown as KeyboardEvent
  // `inside` lists the selectors the target or one of its ancestors matches.
  const element = (tagName: string, inside: string[] = [], type?: string) => ({ tagName, type,
    closest: (selector: string) => selector.split(", ").some(part => inside.includes(part)) ? {} : null })

  it("jumps from the conversation and text fields, the composer included", () => {
    assert.equal(keyAllowsUserMessageJump(key(element("DIV"))), true)
    assert.equal(keyAllowsUserMessageJump(key(null)), true)
    assert.equal(keyAllowsUserMessageJump(key(element("TEXTAREA"))), true)
    assert.equal(keyAllowsUserMessageJump(key(element("INPUT", [], "search"))), true)
  })

  it("leaves code editors, terminals, arrow widgets, popup triggers, other inputs and composition their keys", () => {
    assert.equal(keyAllowsUserMessageJump(key(element("TEXTAREA", [".monaco-editor"]))), false)
    assert.equal(keyAllowsUserMessageJump(key(element("TEXTAREA", [".xterm"]))), false)
    assert.equal(keyAllowsUserMessageJump(key(element("SELECT", ["select"]))), false)
    assert.equal(keyAllowsUserMessageJump(key(element("BUTTON", ["[aria-haspopup]:not([aria-haspopup='false'])"]))), false)
    assert.equal(keyAllowsUserMessageJump(key(element("DIV", ["[role='listbox']"]))), false)
    assert.equal(keyAllowsUserMessageJump(key(element("INPUT", ["[aria-activedescendant]"], "search"))), false)
    assert.equal(keyAllowsUserMessageJump(key(element("INPUT", ["input[aria-controls]"], "search"))), false)
    assert.equal(keyAllowsUserMessageJump(key(element("INPUT", [], "number"))), false)
    assert.equal(keyAllowsUserMessageJump(key(element("TEXTAREA"), { isComposing: true })), false)
    assert.equal(keyAllowsUserMessageJump(key(element("DIV"), { keyCode: 229 })), false)
  })
})
