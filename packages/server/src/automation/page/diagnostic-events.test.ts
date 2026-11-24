import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { DIAGNOSTICS, DiagnosticEventBuffer } from "./diagnostic-events"

test("the native hosts read the same generated specification", () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL("./diagnostic-events.generated.json", import.meta.url), "utf8")), DIAGNOSTICS,
    "run scripts/build-page-function-registry.ts when the specification changes")
})

test("the buffer keeps listed events, reads after a sequence, counts evictions and restarts each document", () => {
  const buffer = new DiagnosticEventBuffer()
  buffer.record("Runtime.consoleAPICalled", { type: "log" })
  buffer.record("Page.frameNavigated", {})
  buffer.record("Log.entryAdded", "not an object")
  const first = buffer.read(0)
  assert.deepEqual(first.events, [{ method: "Runtime.consoleAPICalled", params: { type: "log" } }])
  assert.deepEqual([first.next, first.dropped, first.more], [1, 0, false])
  buffer.clear()
  buffer.record("Log.entryAdded", { entry: {} })
  const second = buffer.read(1)
  assert.notEqual(second.epoch, first.epoch)
  assert.equal(second.dropped, 0, "a navigation's clear is no loss")
  assert.deepEqual(second.events.map(event => event.method), ["Log.entryAdded"])
  for (let index = 0; index < DIAGNOSTICS.maxEvents + 5; index++) buffer.record("Log.entryAdded", { entry: {} })
  // Sequences 2..4007 in this document: 2..7 were evicted, five of them after the cursor.
  const third = buffer.read(2)
  assert.equal(third.dropped, 5)
  assert.equal(third.events.length, DIAGNOSTICS.maxRead)
  assert.equal(third.more, true)
  assert.notEqual(new DiagnosticEventBuffer().read(0).epoch.split(":")[0], third.epoch.split(":")[0], "each buffer has its own epoch")
})
