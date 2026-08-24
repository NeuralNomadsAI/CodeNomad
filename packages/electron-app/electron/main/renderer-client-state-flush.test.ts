import assert from "node:assert/strict"
import test from "node:test"
import { flushRendererClientStateBeforeShutdown, type RendererFlushWindow } from "./renderer-client-state-flush"

const window = (executeJavaScript: (source: string) => Promise<unknown>): RendererFlushWindow => ({
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, getURL: () => "http://127.0.0.1:3000/app", executeJavaScript },
})

test("renderer flush enforces primary/trusted access and invokes the registered callback", async () => {
  let calls = 0
  let source = ""
  const target = window(async (value) => { calls++; source = value })
  assert.equal(await flushRendererClientStateBeforeShutdown(target, false, () => true), "not-primary")
  assert.equal(await flushRendererClientStateBeforeShutdown(target, true, () => false), "untrusted-origin")
  assert.equal(calls, 0)
  assert.equal(await flushRendererClientStateBeforeShutdown(target, true, () => true), "flushed")
  assert.equal(calls, 1)
  assert.match(source, /__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__/)
  assert.match(source, /http:\/\/127\.0\.0\.1:3000/)
})

test("renderer flush rejects after its bounded timeout", async () => {
  await assert.rejects(flushRendererClientStateBeforeShutdown(window(() => new Promise(() => {})), true, () => true, 10), /timed out after 10ms/)
})
