import assert from "node:assert/strict"
import { test } from "node:test"

import { shouldTypeIntoComposer } from "./type-to-focus.ts"

// Minimal element doubles: `closest` reports whether the element (or an
// ancestor) matches the interactive selector, as a focusable scroller does.
const element = (tagName: string, options: { interactive?: boolean; editable?: boolean } = {}) =>
  ({ tagName, isContentEditable: Boolean(options.editable), closest: () => (options.interactive ? {} : null) }) as unknown as Element
const key = (value: string, focused: Element | null, init: Partial<KeyboardEvent> = {}) =>
  ({ key: value, target: focused, defaultPrevented: false, isComposing: false, keyCode: 0, ...init }) as KeyboardEvent

const conversation = element("DIV", { interactive: true })
const body = element("BODY")

test("printable keys typed in the focused conversation resume the composer", () => {
  for (const value of ["a", "Z", "7", "/", "@", "!", "é"]) {
    assert.equal(shouldTypeIntoComposer(key(value, conversation), conversation, conversation), true, value)
  }
  assert.equal(shouldTypeIntoComposer(key("a", body), body, conversation), true, "an unfocused page still types into the composer")
})

test("reading keys stay with the conversation, and modified keys remain shortcuts", () => {
  for (const value of [" ", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Enter", "Tab", "Backspace", "Escape", "F2"]) {
    assert.equal(shouldTypeIntoComposer(key(value, conversation), conversation, conversation), false, value)
  }
  for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
    assert.equal(shouldTypeIntoComposer(key("c", conversation, { [modifier]: true }), conversation, conversation), false, modifier)
  }
  assert.equal(shouldTypeIntoComposer(key("A", conversation, { shiftKey: true }), conversation, conversation), true)
})

test("fields, controls, nested focusable scrollers and IME composition keep their keys", () => {
  const nested = element("PRE", { interactive: true })
  for (const focused of [element("INPUT"), element("TEXTAREA"), element("SELECT"), element("DIV", { editable: true }),
    element("BUTTON", { interactive: true }), nested]) {
    assert.equal(shouldTypeIntoComposer(key("a", focused), focused, conversation), false, focused.tagName)
  }
  assert.equal(shouldTypeIntoComposer(key("a", conversation), conversation, null), false,
    "a focusable element that is not this composer's conversation remains a control")
  assert.equal(shouldTypeIntoComposer(key("a", conversation, { isComposing: true }), conversation, conversation), false)
  assert.equal(shouldTypeIntoComposer(key("Process", conversation, { keyCode: 229 }), conversation, conversation), false)
  assert.equal(shouldTypeIntoComposer(key("a", conversation, { defaultPrevented: true }), conversation, conversation), false)
})
