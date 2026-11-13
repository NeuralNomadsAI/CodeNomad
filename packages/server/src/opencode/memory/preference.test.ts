import assert from "node:assert/strict"
import { EventBus } from "../../events/bus"
import test from "node:test"
import { leaseRequestsMemory, memoryLeaseContent } from "./activation"
import { followMemoryPreference } from "./preference"

test("only an exact version 1 lease requests memory", () => {
  assert.equal(memoryLeaseContent(true), "{\"version\":1,\"memory\":true}")
  assert.equal(memoryLeaseContent(false), "")
  assert.equal(leaseRequestsMemory(memoryLeaseContent(true)), true)
  for (const content of ["", "{", "null", "{\"version\":1,\"design\":true}", "{\"version\":2,\"memory\":true}", "{\"version\":1,\"memory\":1}"]) {
    assert.equal(leaseRequestsMemory(content), false, content)
  }
})

test("memory leases carry the current preference immediately and after server config changes only", () => {
  const events = new EventBus(), contents: string[] = []
  let server: Record<string, unknown> = {}
  const settings = { getRawConfigOwner: (owner: string) => {
    assert.equal(owner, "server")
    if (server === null) throw new Error("unreadable")
    return server
  } }
  const stop = followMemoryPreference(settings as never, events, { setLeaseContent: async content => { contents.push(content) } })
  assert.deepEqual(contents, [""], "absence means disabled")
  server = { memoryEnabled: true }
  events.emit("storage.configChanged", { owner: "ui" })
  assert.deepEqual(contents, [""], "unrelated owners are ignored")
  events.emit("storage.configChanged", { owner: "server" })
  assert.deepEqual(contents, ["", memoryLeaseContent(true)])
  server = { memoryEnabled: "yes" }
  events.emit("storage.configChanged", { owner: "*" })
  server = null as never
  events.emit("storage.configChanged", { owner: "server" })
  assert.deepEqual(contents.slice(2), ["", ""], "invalid and unreadable preferences request nothing")
  stop()
  events.emit("storage.configChanged", { owner: "server" })
  assert.equal(contents.length, 4)
})
