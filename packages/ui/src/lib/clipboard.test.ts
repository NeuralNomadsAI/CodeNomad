import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { copyTextChunksToClipboard, copyToClipboard } from "./clipboard"
import { installClipboardFallbackDom } from "./clipboard.test-fixture"

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

  it("checks authority after fallback focus handlers before dispatching execCommand", async () => {
    let writes = 0
    const state = installClipboardFallbackDom(() => { writes++; return true })
    const controller = new AbortController()
    state.textArea.focus = () => controller.abort()
    try {
      assert.equal(await copyToClipboard("obsolete", { signal: controller.signal }), false)
      assert.equal(writes, 0)
      assert.equal(state.removed(), true)
    } finally { state.restore() }
  })

  it("does not dispatch any strategy with an aborted signal or expired authority", async () => {
    let writes = 0
    const state = installClipboardFallbackDom(() => { writes++; return true }, {
      write: async () => { writes++ }, writeText: async () => { writes++ },
    })
    try {
      for (const options of [{ signal: AbortSignal.abort() }, { isCurrent: () => false }]) {
        assert.equal(await copyTextChunksToClipboard(["obsolete"], options), false)
        assert.equal(await copyToClipboard("obsolete", options), false)
      }
      assert.equal(writes, 0)
    } finally { state.restore() }
  })
})
