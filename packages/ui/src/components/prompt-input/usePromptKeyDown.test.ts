import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { usePromptKeyDown } from "./usePromptKeyDown.ts"
import { matchesHotkeyBinding, resolveHotkeyBindings, type HotkeyOverrides } from "../../lib/hotkey-bindings"

function setup(submitOnEnter = true, pickerOpen = false, overrides: HotkeyOverrides = {}) {
  let prompt = "hello"
  const sends: Array<boolean | undefined> = []
  let backgrounds = 0
  let mode: "normal" | "shell" = "normal"
  const history: string[] = []
  const textarea = {
    get value() { return prompt },
    set value(value: string) { prompt = value },
    selectionStart: prompt.length,
    selectionEnd: prompt.length,
    disabled: false,
    focus() {},
    setSelectionRange(start: number, end: number) {
      textarea.selectionStart = start
      textarea.selectionEnd = end
    },
    setRangeText(value: string, start: number, end: number) {
      prompt = prompt.slice(0, start) + value + prompt.slice(end)
      textarea.selectionStart = textarea.selectionEnd = start + value.length
    },
  } as unknown as HTMLTextAreaElement
  const handler = usePromptKeyDown({
    getTextarea: () => textarea,
    prompt: () => prompt,
    setPrompt: (value) => { prompt = value },
    mode: () => mode,
    setMode: (value) => { mode = value },
    isPickerOpen: () => pickerOpen,
    closePicker: () => { pickerOpen = false },
    ignoredAtPositions: () => new Set(),
    setIgnoredAtPositions: () => {},
    getAttachments: () => [],
    removeAttachment: () => {},
    submitOnEnter: () => submitOnEnter,
    matchHotkey: (id, event) => resolveHotkeyBindings(id, overrides, submitOnEnter, false)
      .some(binding => matchesHotkeyBinding(binding, event, false)),
    onSend: (alternate) => sends.push(alternate),
    onBackground: () => {
      backgrounds += 1
      return true
    },
    selectPreviousHistory: () => { history.push("previous"); return true },
    selectNextHistory: () => { history.push("next"); return true },
  })
  const press = (input: Partial<KeyboardEvent>) => {
    let prevented = false, stopped = false
    handler({
      key: "Enter",
      code: input.key ?? "Enter",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      isComposing: false,
      repeat: false,
      preventDefault() { prevented = true },
      stopPropagation() { stopped = true },
      ...input,
    } as KeyboardEvent)
    return { prevented, stopped }
  }
  return { press, sends, textarea, backgrounds: () => backgrounds, prompt: () => prompt, history,
    mode: () => mode, enterShell: () => { mode = "shell" } }
}

describe("prompt submit shortcuts", () => {
  it("inserts newline and places the caret synchronously without resetting later input", async () => {
    const input = setup(true, false, { "prompt-newline": [{ key: "F8" }] })
    input.textarea.value = "beforeafter"
    input.textarea.setSelectionRange(6, 6)
    input.press({ key: "F8" })
    assert.equal(input.prompt(), "before\nafter")
    assert.equal(input.textarea.selectionStart, 7)
    input.textarea.setSelectionRange(12, 12)
    input.textarea.setRangeText("X", 12, 12, "end")
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(input.textarea.selectionStart, 13, "later caret changes remain authoritative")
    input.textarea.setRangeText("Y", input.textarea.selectionStart, input.textarea.selectionEnd, "end")
    assert.equal(input.prompt(), "before\nafterXY")
  })
  for (const submitOnEnter of [true, false]) {
    it(`leaves native newline editing intact with submitOnEnter=${submitOnEnter}`, () => {
      const input = setup(submitOnEnter)
      for (const modifiers of submitOnEnter ? [{ shiftKey: true }] : [{}, { shiftKey: true }]) {
        assert.deepEqual(input.press(modifiers), { prevented: false, stopped: true })
        assert.equal(input.prompt(), "hello", "the browser owns the edit and resulting input event")
        assert.deepEqual(input.sends, [])
      }
    })
  }
  it("does not insert remapped newlines during composition or after consumed keys", () => {
    const input = setup(true, false, { "prompt-newline": [{ key: "F8" }] })
    for (const flags of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
      assert.deepEqual(input.press({ key: "F8", ...flags }), { prevented: false, stopped: false })
      assert.equal(input.prompt(), "hello")
    }
  })
  it("does not send a key already consumed by a picker that closed during dispatch", () => {
    const input = setup()
    input.press({ defaultPrevented: true })
    input.press({ defaultPrevented: true, ctrlKey: true, shiftKey: true })
    assert.deepEqual(input.sends, [])
    assert.equal(input.prompt(), "hello")
  })

  for (const submitOnEnter of [true, false]) {
    it(`reserves Enter for an open picker with submitOnEnter=${submitOnEnter}`, () => {
      const input = setup(submitOnEnter, true)
      for (const modifiers of [{}, { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true },
        { ctrlKey: true, shiftKey: true }, { metaKey: true, shiftKey: true }]) {
        const handled = input.press(modifiers)
        assert.equal(handled.prevented, true, "an empty or not-yet-mounted picker cannot insert a newline")
        assert.equal(handled.stopped, Boolean(modifiers.ctrlKey || modifiers.metaKey))
        assert.deepEqual(input.sends, [], "picker Enter cannot send or queue the draft")
        assert.equal(input.prompt(), "hello")
      }
    })
  }

  it("sends normally on Enter and uses alternate delivery on Alt+Enter and Mod+Shift+Enter", () => {
    const input = setup()
    input.press({})
    input.press({ altKey: true })
    input.press({ ctrlKey: true, shiftKey: true })
    assert.deepEqual(input.sends, [false, true, true])
    // AltGr arrives as Ctrl+Alt and is not the alternate send.
    input.press({ ctrlKey: true, altKey: true })
    assert.deepEqual(input.sends, [false, true, true])
  })

  it("keeps Mod+Enter as a newline", () => {
    const input = setup()
    input.press({ ctrlKey: true })
    assert.equal(input.prompt(), "hello\n")
    assert.deepEqual(input.sends, [])
  })

  it("keeps Alt+Enter and Mod+Shift+Enter as alternate delivery when Enter inserts a newline", () => {
    const input = setup(false)
    input.press({ altKey: true })
    input.press({ ctrlKey: true, shiftKey: true })
    assert.deepEqual(input.sends, [true, true])
  })

  it("moves blocking session work to the background on Mod+B", () => {
    const input = setup()
    input.press({ key: "b", ctrlKey: true })
    assert.equal(input.backgrounds(), 1)
    assert.deepEqual(input.sends, [])
  })

  it("uses remapped send/newline bindings and leaves the old keys inert", () => {
    const input = setup(true, false, {
      "prompt-send": [{ key: "F9" }],
      "prompt-newline": [{ key: "F8" }],
      "prompt-alternate-send": [],
    })
    input.press({})
    input.press({ ctrlKey: true })
    input.press({ ctrlKey: true, shiftKey: true })
    assert.deepEqual(input.sends, [])
    assert.equal(input.prompt(), "hello")
    input.press({ key: "F9" })
    input.press({ key: "F8" })
    assert.deepEqual(input.sends, [false])
    assert.equal(input.prompt(), "hello\n")
  })

  it("does not submit IME composition or a remapped send while a picker is open", () => {
    const input = setup(true, false, { "prompt-send": [{ key: "F9" }] })
    input.press({ key: "F9", isComposing: true })
    input.press({ key: "F9", keyCode: 229 })
    assert.deepEqual(input.sends, [])
    const picker = setup(true, true, { "prompt-send": [{ key: "F9" }] })
    assert.equal(picker.press({ key: "F9" }).prevented, true)
    assert.deepEqual(picker.sends, [])
  })

  it("remaps history, background and shell exit without replacing local editing keys", () => {
    const input = setup(true, false, {
      "prompt-history-prev": [{ key: "F6" }],
      "prompt-history-next": [{ key: "F7" }],
      "session-background": [{ key: "F8" }],
      "prompt-exit-shell": [{ key: "F10" }],
    })
    input.press({ key: "ArrowUp" })
    input.press({ key: "ArrowDown" })
    input.press({ key: "b", ctrlKey: true })
    assert.deepEqual(input.history, [])
    assert.equal(input.backgrounds(), 0)
    input.press({ key: "F6" })
    input.press({ key: "F7" })
    input.press({ key: "F8" })
    assert.deepEqual(input.history, ["previous", "next"])
    assert.equal(input.backgrounds(), 1)
    input.enterShell()
    input.press({ key: "Escape" })
    assert.equal(input.mode(), "shell")
    input.press({ key: "F10" })
    assert.equal(input.mode(), "normal")
  })
})
