import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { copyToClipboard } from "./clipboard"

describe("copyToClipboard fallback", () => {
  it("restores focus and removes its temporary textarea", async () => {
    const state = installClipboardFallbackDom(() => true)
    try {
      assert.equal(await copyToClipboard("diagnostics"), true)
      assert.equal(state.textArea.readOnly, true)
      assert.equal(state.removed(), true)
      assert.equal(state.focusRestored(), true)
    } finally {
      state.restore()
    }
  })

  it("cleans up when the fallback copy throws", async () => {
    const state = installClipboardFallbackDom(() => {
      throw new Error("copy failed")
    })
    try {
      assert.equal(await copyToClipboard("diagnostics"), false)
      assert.equal(state.removed(), true)
      assert.equal(state.focusRestored(), true)
    } finally {
      state.restore()
    }
  })
})

function installClipboardFallbackDom(execCommand: () => boolean) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
  let removed = false
  let focusRestored = false
  const textArea = {
    value: "",
    readOnly: false,
    style: {} as CSSStyleDeclaration,
    focus() {},
    select() {},
    remove() { removed = true },
  }
  const activeElement = { focus() { focusRestored = true } }
  const documentMock = {
    activeElement,
    createElement: () => textArea,
    body: { appendChild() {} },
    execCommand,
  }

  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} })
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock })

  return {
    textArea,
    removed: () => removed,
    focusRestored: () => focusRestored,
    restore() {
      restoreGlobal("navigator", navigatorDescriptor)
      restoreGlobal("document", documentDescriptor)
    },
  }
}

function restoreGlobal(name: "navigator" | "document", descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else Reflect.deleteProperty(globalThis, name)
}
