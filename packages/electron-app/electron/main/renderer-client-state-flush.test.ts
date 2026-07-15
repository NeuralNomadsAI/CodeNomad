import assert from "node:assert/strict"
import test from "node:test"
import { flushRendererClientStateBeforeShutdown, type RendererFlushWindow } from "./renderer-client-state-flush"

function createWindow(executeJavaScript: (source: string) => Promise<unknown>): RendererFlushWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      getURL: () => "http://127.0.0.1:3000/app",
      executeJavaScript,
    },
  }
}

test("renderer flush only executes for a primary trusted window", async () => {
  let calls = 0
  const window = createWindow(async () => {
    calls += 1
  })

  assert.equal(await flushRendererClientStateBeforeShutdown(window, false, () => true), "not-primary")
  assert.equal(await flushRendererClientStateBeforeShutdown(window, true, () => false), "untrusted-origin")
  assert.equal(calls, 0)
})

test("renderer flush awaits the registered shutdown callback", async () => {
  let source = ""
  const window = createWindow(async (value) => {
    source = value
  })

  assert.equal(await flushRendererClientStateBeforeShutdown(window, true, () => true), "flushed")
  assert.match(source, /__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__/)
  assert.match(source, /http:\/\/127\.0\.0\.1:3000/)
})

test("renderer flush rejects after its bounded timeout", async () => {
  const window = createWindow(() => new Promise(() => {}))
  await assert.rejects(
    flushRendererClientStateBeforeShutdown(window, true, () => true, 10),
    /timed out after 10ms/,
  )
})
