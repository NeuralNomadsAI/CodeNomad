import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { usePromptKeyDown } from "./usePromptKeyDown.ts"

function setup(submitOnEnter = true) {
  let prompt = "hello"
  const sends: Array<boolean | undefined> = []
  let backgrounds = 0
  const textarea = {
    selectionStart: prompt.length,
    selectionEnd: prompt.length,
    disabled: false,
    focus() {},
    setSelectionRange(start: number, end: number) {
      textarea.selectionStart = start
      textarea.selectionEnd = end
    },
  } as unknown as HTMLTextAreaElement
  const handler = usePromptKeyDown({
    getTextarea: () => textarea,
    prompt: () => prompt,
    setPrompt: (value) => { prompt = value },
    mode: () => "normal",
    setMode: () => {},
    isPickerOpen: () => false,
    closePicker: () => {},
    ignoredAtPositions: () => new Set(),
    setIgnoredAtPositions: () => {},
    getAttachments: () => [],
    removeAttachment: () => {},
    submitOnEnter: () => submitOnEnter,
    onSend: (alternate) => sends.push(alternate),
    onBackground: () => {
      backgrounds += 1
      return true
    },
    selectPreviousHistory: () => false,
    selectNextHistory: () => false,
  })
  const press = (input: Partial<KeyboardEvent>) => handler({
    key: "Enter",
    preventDefault() {},
    stopPropagation() {},
    ...input,
  } as KeyboardEvent)
  return { press, sends, backgrounds: () => backgrounds, prompt: () => prompt }
}

describe("prompt submit shortcuts", () => {
  it("sends normally on Enter and queues only on Mod+Shift+Enter", () => {
    const input = setup()
    input.press({})
    input.press({ ctrlKey: true, shiftKey: true })
    assert.deepEqual(input.sends, [false, true])
  })

  it("keeps Mod+Enter as a newline", () => {
    const input = setup()
    input.press({ ctrlKey: true })
    assert.equal(input.prompt(), "hello\n")
    assert.deepEqual(input.sends, [])
  })

  it("keeps Mod+Shift+Enter as queue when Enter inserts a newline", () => {
    const input = setup(false)
    input.press({ ctrlKey: true, shiftKey: true })
    assert.deepEqual(input.sends, [true])
  })

  it("moves blocking session work to the background on Mod+B", () => {
    const input = setup()
    input.press({ key: "b", ctrlKey: true })
    assert.equal(input.backgrounds(), 1)
    assert.deepEqual(input.sends, [])
  })
})
