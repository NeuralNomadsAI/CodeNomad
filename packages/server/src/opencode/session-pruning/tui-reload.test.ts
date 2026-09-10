import assert from "node:assert/strict"
import { test } from "node:test"
import { createPruningReload } from "./tui-reload"

test("TUI companion coalesces invalidations and rereads after a missed-event reconnect", async () => {
  const invalidated: string[] = []
  const read: string[] = []
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const reload = createPruningReload({
    list: () => [{ id: "s" }, { id: "unloaded" }],
    get: id => id === "s" ? { location: { directory: "/work" } } : undefined,
    message: {
      list: id => id === "s" ? [{}] : [],
      invalidate: id => { invalidated.push(id) },
      sync: async id => { read.push(id); await pending },
    },
  })
  const event = { type: "rpc.codenomad.session-pruning.pruned", location: { directory: "/work" }, data: { sessionID: "s", messageID: "m", revision: "a".repeat(64) } }
  reload.event(event); reload.event(event)
  assert.deepEqual(read, ["s"])
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(read, ["s", "s"])
  reload.event({ type: "server.connected" })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(read, ["s", "s", "s"])
  assert(invalidated.includes("unloaded"))
  reload.dispose()
  reload.event(event)
  assert.equal(read.length, 3)
})

test("TUI companion rejects foreign locations, malformed events and unknown sessions", () => {
  const reload = createPruningReload({
    list: () => [], get: id => id === "s" ? { location: { directory: "/work" } } : undefined,
    message: { list: () => [], invalidate: () => assert.fail("unexpected invalidation"), sync: async () => assert.fail("unexpected read") },
  })
  reload.event({ type: "rpc.other.pruned", data: {} })
  reload.event({ type: "rpc.codenomad.session-pruning.pruned", data: {} })
  for (const sessionID of ["s", "other"]) reload.event({ type: "rpc.codenomad.session-pruning.pruned", location: { directory: "/elsewhere" }, data: { sessionID, messageID: "m", revision: "a".repeat(64) } })
  reload.dispose()
})
