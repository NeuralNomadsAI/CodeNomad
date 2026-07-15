import assert from "node:assert/strict"
import test from "node:test"
import { MainWindowCloseController } from "./main-window-close"

test("a close-only request flushes renderer and native state before approving close", async () => {
  const calls: string[] = []
  let controller: MainWindowCloseController
  controller = new MainWindowCloseController({
    flushRenderer: async () => {
      calls.push("renderer")
    },
    flushNative: async () => {
      calls.push("native")
    },
    closeWindow: () => {
      calls.push("close")
      assert.equal(controller.handleClose().allow, true)
    },
    reportError: () => assert.fail("close flow should not report an error"),
  })

  const decision = controller.handleClose()
  assert.equal(decision.allow, false)
  await decision.completion
  assert.deepEqual(calls, ["renderer", "native", "close"])
})

test("repeated close requests share one in-progress flush", async () => {
  let releaseRenderer: (() => void) | undefined
  let rendererFlushes = 0
  let nativeFlushes = 0
  let closes = 0
  const controller = new MainWindowCloseController({
    flushRenderer: () => {
      rendererFlushes += 1
      return new Promise<void>((resolve) => {
        releaseRenderer = resolve
      })
    },
    flushNative: async () => {
      nativeFlushes += 1
    },
    closeWindow: () => {
      closes += 1
    },
    reportError: () => assert.fail("close flow should not report an error"),
  })

  const first = controller.handleClose()
  const second = controller.handleClose()
  assert.equal(first.allow, false)
  assert.equal(second.allow, false)
  assert.equal(second.completion, first.completion)
  assert.equal(rendererFlushes, 1)

  releaseRenderer?.()
  await first.completion
  assert.equal(nativeFlushes, 1)
  assert.equal(closes, 1)
})

test("renderer flush failure still flushes native state and closes", async () => {
  const errors: string[] = []
  let nativeFlushed = false
  let closed = false
  const controller = new MainWindowCloseController({
    flushRenderer: async () => {
      throw new Error("timed out")
    },
    flushNative: async () => {
      nativeFlushed = true
    },
    closeWindow: () => {
      closed = true
    },
    reportError: (stage) => errors.push(stage),
  })

  await controller.handleClose().completion
  assert.equal(nativeFlushed, true)
  assert.equal(closed, true)
  assert.deepEqual(errors, ["renderer"])
})
