import assert from "node:assert/strict"
import { test } from "node:test"
import { OpenCodeSharedService } from "./opencode-service"
import { rememberRuntime } from "../opencode/compatibility/runtime"
import type { Endpoint } from "@opencode/client/service"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"

test("same URL and credentials cannot keep the previous daemon's adapter or invalidate its replacement", async () => {
  let now = 0
  const makeEndpoint = (version: string, pid: number): Endpoint => {
    const endpoint = { url: "http://127.0.0.1:4321" }
    rememberRuntime(endpoint, { version, pid, discovery: "info" })
    return endpoint
  }
  let endpoint = makeEndpoint("2.0.11", 1)
  const service = new OpenCodeSharedService({ headers: () => undefined, makeClient: () => ({}) as never, now: () => now })
  await service.endpoint({ kind: "lifecycle", identity: "test", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
  const old = await service.acquire()
  endpoint = makeEndpoint("2.0.11", 2)
  now = 30_000
  const current = await service.acquire()
  assert.notEqual(current, old)
  assert.throws(old.assertCurrent, /connection changed/)
  old.invalidate()
  current.assertCurrent()
  assert.equal(await service.acquire(), current)
  endpoint = makeEndpoint("2.0.10", 3)
  now = 60_000
  await assert.rejects(service.acquire(), /opencode_update_required/)
  assert.throws(current.assertCurrent, /connection changed/)
  await service.shutdown()
  assert.throws(current.assertCurrent, /connection changed/)
})

test("invalidation during asynchronous mutation preparation prevents upstream dispatch", async (context) => {
  const endpoint = { url: "http://127.0.0.1:4321" }
  rememberRuntime(endpoint, { version: "2.0.11", pid: 1, discovery: "info" })
  const upstream = context.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }))
  const service = new OpenCodeSharedService()
  await service.endpoint({ kind: "lifecycle", identity: "test", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
  const connection = await service.acquire()
  const pending = connection.fetch(`${endpoint.url}/api/session/s`, { method: "PATCH", body: JSON.stringify({ title: "fixture" }) })
  service.invalidate()
  await service.acquire()
  await assert.rejects(pending, /connection changed/)
  assert.equal(upstream.mock.callCount(), 0)
})

test("a late old stream cannot publish events or invalidate the replacement connection", async () => {
  const endpoint = { url: "http://127.0.0.1:4321" }
  const service = new OpenCodeSharedService({ headers: () => undefined, makeClient: () => ({
    event: { subscribe: () => (async function* () {
      yield { type: "server.connected", data: {} } as OpenCodeEvent
      yield { type: "catalog.updated", data: {} } as unknown as OpenCodeEvent
    })() },
  }) as unknown as OpenCodeClient })
  await service.endpoint({ kind: "lifecycle", identity: "test", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
  const iterator = (await service.subscribe())[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.type, "server.connected")
  service.invalidate()
  const current = await service.acquire()
  await assert.rejects(iterator.next(), /connection changed/)
  current.assertCurrent()
  assert.equal(await service.acquire(), current)
})
