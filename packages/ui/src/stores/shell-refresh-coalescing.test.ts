import assert from "node:assert/strict"
import { it } from "node:test"
import { createShellStore } from "./shell-store"

it("shares mounted Shell reads and coalesces an event burst into one authoritative follow-up", async () => {
  const pending: Array<(value: any[]) => void> = []
  const store = createShellStore(() => ({
    list: () => new Promise(resolve => pending.push(resolve)),
    remove: async () => {},
    output: async () => ({ output: "", cursor: 0, size: 0, truncated: false }),
  }))
  const reads = Array.from({ length: 30 }, () => store.load("instance", "/repo"))
  await Promise.resolve()
  assert.equal(pending.length, 1)
  const events = Array.from({ length: 20 }, () => store.refreshForEvent("instance", {
    type: "shell.created", location: { directory: "/repo" },
  }))
  pending[0]([{ id: "obsolete" }])
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(pending.length, 2)
  assert.equal(store.getState("instance", "/repo").loading, true)
  assert.deepEqual(store.getState("instance", "/repo").items, [])
  pending[1]([{ id: "current" }])
  await Promise.all([...reads, ...events])
  assert.deepEqual(store.getState("instance", "/repo").items.map(item => item.id), ["current"])
  assert.equal(store.getState("instance", "/repo").loading, false)
})

it("a successful removal waits for a new read rather than accepting an in-flight pre-removal snapshot", async () => {
  let resolve!: (value: any[]) => void
  let calls = 0
  const store = createShellStore(() => ({
    list: async () => ++calls === 1 ? new Promise<any[]>(done => { resolve = done }) : [],
    remove: async () => {},
    output: async () => ({ output: "", cursor: 0, size: 0, truncated: false }),
  }))
  const read = store.load("instance", "/repo")
  await Promise.resolve()
  const removal = store.remove("instance", "/repo", "removed")
  await Promise.resolve()
  resolve([{ id: "removed" }])
  await read
  assert.equal(await removal, true)
  assert.equal(calls, 2)
  assert.deepEqual(store.getState("instance", "/repo").items, [])
})
