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
  assert.equal((wide.read(0).events[0].params.entry as any).text.length, DIAGNOSTICS.maxText + 1,
    "a payload over the read bound in UTF-8 bytes keeps its text cut, still marked as longer")
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

test("a console flood never evicts a request's lifecycle, and a lost network event loses its request", () => {
  const buffer = new DiagnosticEventBuffer()
  buffer.record("Network.requestWillBeSent", { requestId: "r1" })
  buffer.read(0)
  buffer.record("Network.loadingFinished", { requestId: "r1" })
  for (let index = 0; index < DIAGNOSTICS.maxEvents + 5; index++) buffer.record("Runtime.consoleAPICalled", { args: [] })
  const flooded = buffer.read(1)
  assert.equal(flooded.lost.messages, 5)
  assert.equal(flooded.lost.requests, 0)
  assert.equal(flooded.events[0].method, "Network.loadingFinished", "the request still completes")
  const network = new DiagnosticEventBuffer()
  for (let index = 0; index < DIAGNOSTICS.maxEvents + 2; index++) network.record("Network.dataReceived", { requestId: `n${index}` })
  network.record("Network.loadingFinished", { requestId: "n0" })
  assert.equal(network.read(0).lost.requests, 0, "dataReceived is not a listed event")
  for (let index = 0; index < DIAGNOSTICS.maxEvents + 2; index++) network.record("Network.loadingFinished", { requestId: `f${index % 2}` })
  assert.equal(network.read(0).lost.requests, 2, "each request that lost an unread event counts once")
})
test("a frame detach stays with the requests it ends", () => {
  const buffer = new DiagnosticEventBuffer()
  buffer.record("Target.detachedFromTarget", { sessionId: "frame" })
  for (let index = 0; index < DIAGNOSTICS.maxEvents + 1; index++) buffer.record("Runtime.consoleAPICalled", { args: [] })
  assert.equal(buffer.read(0).events[0].method, "Target.detachedFromTarget")
})

test("only a lost ending event or frame detach ends a request", () => {
  const buffer = new DiagnosticEventBuffer()
  buffer.record("Target.detachedFromTarget", { sessionId: "frame" })
  buffer.record("Network.requestWillBeSentExtraInfo", { requestId: "r1" })
  buffer.record("Network.loadingFinished", { requestId: "r2" })
  for (let index = 0; index < DIAGNOSTICS.maxEvents + 3; index++) buffer.record("Network.responseReceivedExtraInfo", { requestId: "r9" })
  const read = buffer.read(0)
  assert.deepEqual(read.lostRequests.sort(), [":r2", "frame:*"])
  assert.equal(read.lost.requests, 3, "every request that lost an event is counted")
})

test("detach markers are bounded, and a lost WebSocket handshake ends its socket", () => {
  const buffer = new DiagnosticEventBuffer()
  for (let index = 0; index < DIAGNOSTICS.maxEvents * 3; index++) buffer.record("Target.detachedFromTarget", { sessionId: `frame-${index}` })
  assert.ok(buffer.read(0).lostRequests.length <= DIAGNOSTICS.maxEvents)
  const sockets = new DiagnosticEventBuffer()
  sockets.record("Network.webSocketHandshakeResponseReceived", { requestId: "ws1" })
  for (let index = 0; index < DIAGNOSTICS.maxEvents + 1; index++) sockets.record("Network.requestWillBeSentExtraInfo", { requestId: "r9" })
  assert.deepEqual(sockets.read(0).lostRequests, [":ws1"])
})