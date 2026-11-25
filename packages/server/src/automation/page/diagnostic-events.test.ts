import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { DIAGNOSTICS, DiagnosticEventBuffer } from "./diagnostic-events"

test("the native hosts read the same generated specification", () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL("./diagnostic-events.generated.json", import.meta.url), "utf8")), DIAGNOSTICS,
    "run scripts/build-page-function-registry.ts when the specification changes")
})

test("the buffer keeps listed events, reads after a sequence and restarts each document", () => {
  const buffer = new DiagnosticEventBuffer()
  buffer.record("Runtime.consoleAPICalled", { type: "log" })
  buffer.record("Page.frameNavigated", {})
  buffer.record("Log.entryAdded", "not an object")
  const first = buffer.read(0)
  assert.deepEqual(first.events, [{ method: "Runtime.consoleAPICalled", params: { type: "log" } }])
  assert.deepEqual([first.next, first.lost, first.more], [1, { messages: 0, requests: 0 }, false])
  buffer.restart()
  buffer.record("Log.entryAdded", { entry: {} })
  const second = buffer.read(1)
  assert.notEqual(second.epoch, first.epoch)
  assert.deepEqual(second.events.map(event => event.method), ["Log.entryAdded"])
  assert.notEqual(new DiagnosticEventBuffer().read(0).epoch.split(":")[0], second.epoch.split(":")[0], "each buffer has its own epoch")
})

test("only unread evictions count, by the readout they would feed, and sizes are UTF-8 bytes", () => {
  const buffer = new DiagnosticEventBuffer()
  buffer.record("Network.requestWillBeSent", { requestId: "r1" })
  buffer.read(0)
  for (let index = 0; index < DIAGNOSTICS.maxEvents + 3; index++) buffer.record("Log.entryAdded", { entry: {} })
  const read = buffer.read(1)
  assert.deepEqual(read.lost, { messages: 3, requests: 0 }, "the read request is no loss; three unread entries are")
  assert.equal(read.events.length, DIAGNOSTICS.maxRead)
  assert.equal(read.more, true)
  const wide = new DiagnosticEventBuffer()
  const text = "é".repeat(DIAGNOSTICS.maxReadBytes / 2)
  wide.record("Log.entryAdded", { entry: { text } })
  assert.deepEqual(wide.read(0).events, [], "a payload over the read bound in UTF-8 bytes is not kept")
})

test("live execution contexts outlast restarts and evictions, and a detached frame's go", () => {
  const buffer = new DiagnosticEventBuffer()
  buffer.record("Runtime.executionContextCreated", { context: { id: 1, auxData: { frameId: "main", isDefault: true } } })
  buffer.record("Runtime.executionContextCreated", { context: { id: 2, auxData: { frameId: "main", isDefault: false } } })
  buffer.record("Runtime.executionContextCreated", { context: { id: 1, auxData: { frameId: "child", isDefault: true } } }, "frame")
  buffer.restart()
  for (let index = 0; index < DIAGNOSTICS.maxEvents + 1; index++) buffer.record("Log.entryAdded", { entry: {} })
  assert.deepEqual(buffer.read(0).contexts, [{ id: 1, page: true }, { id: 2, page: false }, { session: "frame", id: 1, page: true }])
  buffer.record("Target.detachedFromTarget", { sessionId: "frame" })
  buffer.record("Runtime.executionContextDestroyed", { executionContextId: 2 })
  assert.deepEqual(buffer.read(0).contexts, [{ id: 1, page: true }])
  buffer.record("Runtime.executionContextsCleared", {})
  assert.deepEqual(buffer.read(0).contexts, [])
  for (let id = 0; id < DIAGNOSTICS.maxContexts + 5; id++) buffer.record("Runtime.executionContextCreated", { context: { id, auxData: {} } })
  assert.equal(buffer.read(0).contexts.length, DIAGNOSTICS.maxContexts)
})