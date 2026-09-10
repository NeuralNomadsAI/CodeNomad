import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
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
      loading: () => false,
      loadMore: async () => assert.fail("unexpected pagination"),
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
    message: {
      list: () => [], loading: () => false, loadMore: async () => assert.fail("unexpected pagination"),
      invalidate: () => assert.fail("unexpected invalidation"), sync: async () => assert.fail("unexpected read"),
    },
  })
  reload.event({ type: "rpc.other.pruned", data: {} })
  reload.event({ type: "rpc.codenomad.session-pruning.pruned", data: {} })
  for (const sessionID of ["s", "other"]) reload.event({ type: "rpc.codenomad.session-pruning.pruned", location: { directory: "/elsewhere" }, data: { sessionID, messageID: "m", revision: "a".repeat(64) } })
  reload.dispose()
})

test("TUI reload regressions against the installed published Solid cache", () => {
  // Keep Solid's browser conditions out of the server test process. Resolve the
  // native client from the pinned plugin dependency, not a checkout, global
  // install, copied cache implementation, or a network install during tests.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    "--conditions=browser", "--import", "tsx", "--test",
    fileURLToPath(new URL("./tui-reload.native.ts", import.meta.url)),
  ], { encoding: "utf8", timeout: 30_000, env })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /control: invalidate\/sync/, "The child must actually execute its native-cache tests")
})

test("TUI companion refuses a cache without public pagination coordination", () => {
  assert.throws(() => createPruningReload({
    list: () => [], get: () => undefined,
    message: { list: () => [], invalidate: () => {}, sync: async () => {} },
  }), /pagination publication API is unavailable/)
})
