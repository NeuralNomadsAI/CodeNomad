import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import type { ServerResponse } from "node:http"
import Fastify from "fastify"
import type { OpenCodeEvent } from "@opencode/client"
import { OpenCodeSharedService } from "./opencode-service"

async function transport(t: TestContext) {
  const upstream = Fastify()
  const streams: ServerResponse[] = []
  upstream.get("/api/event", (_request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.flushHeaders()
    reply.hijack()
    streams.push(reply.raw)
    reply.raw.write(`data: ${JSON.stringify({ id: "connected", created: Date.now(), type: "server.connected", data: {} })}\n\n`)
  })
  upstream.get("/api/info", async () => ({ version: "fixture" }))
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const endpoint = { url: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}` }
  const service = new OpenCodeSharedService()
  // Only CLI lifecycle/upstream are fixtures. SDK sharing, cancellation, SSE
  // parsing and the CodeNomad connection fences remain real.
  const client = await service.client({ kind: "lifecycle", identity: "isolated-event-transport",
    lifecycle: { discover: async () => endpoint, ensure: async () => endpoint },
  })
  t.after(async () => {
    await service.shutdown()
    for (const stream of streams) stream.destroy()
    await upstream.close()
  })
  return { service, client, streams,
    send(event: OpenCodeEvent) { streams.at(-1)!.write(`data: ${JSON.stringify(event)}\n\n`) },
  }
}

for (const mode of ["abort", "return", "throw"] as const) {
  test(`one subscriber's ${mode} cannot invalidate another subscriber or the healthy client`, async t => {
    const f = await transport(t)
    const controller = new AbortController()
    const other = f.client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
    t.after(async () => { controller.abort(); await other.return?.() })
    assert.equal((await other.next()).value?.type, "server.connected")
    const local = new AbortController()
    const wrapped = (await f.service.subscribe({ signal: local.signal }))[Symbol.asyncIterator]()
    t.after(async () => { local.abort(); await wrapped.return?.() })
    assert.equal((await wrapped.next()).value?.type, "server.connected")
    assert.equal(f.streams.length, 1, "both consumers must share one physical HTTP stream")
    if (mode === "abort") {
      const waiting = wrapped.next()
      local.abort()
      assert.equal((await waiting).done, true)
    } else if (mode === "throw") {
      const failure = new Error("consumer failure")
      await assert.rejects(wrapped.throw!(failure), error => error === failure)
    } else await wrapped.return?.()
    assert.equal((await f.client.server.info()).version, "fixture")
    assert.equal((await f.service.acquire()).client, f.client)
    const next = other.next()
    const renamed = { id: "after-local-stop", created: Date.now(), type: "session.renamed" as const,
      durable: { aggregateID: "session", seq: 1, version: 1 as const },
      data: { sessionID: "session", title: "still shared" },
    }
    f.send(renamed)
    assert.deepEqual((await next).value, renamed)
  })
}

test("an already-aborted subscriber never opens a stream or invalidates the healthy connection", async t => {
  const f = await transport(t)
  const controller = new AbortController()
  controller.abort()
  const wrapped = (await f.service.subscribe({ signal: controller.signal }))[Symbol.asyncIterator]()
  assert.equal((await wrapped.next()).done, true)
  assert.equal((await f.service.acquire()).client, f.client)
  assert.equal(f.streams.length, 0)
})

test("genuine upstream EOF invalidates its connection but late cleanup cannot invalidate its replacement", async t => {
  const f = await transport(t)
  const controller = new AbortController()
  const wrapped = (await f.service.subscribe({ signal: controller.signal }))[Symbol.asyncIterator]()
  t.after(async () => { controller.abort(); await wrapped.return?.() })
  assert.equal((await wrapped.next()).value?.type, "server.connected")
  const ended = wrapped.next()
  f.streams[0].end()
  assert.equal((await ended).done, true)
  const replacement = await f.service.acquire()
  assert.notEqual(replacement.client, f.client)
  await wrapped.return?.()
  assert.equal(await f.service.acquire(), replacement)
})

test("abrupt upstream transport failure still invalidates its connection", async t => {
  const f = await transport(t)
  const controller = new AbortController()
  const wrapped = (await f.service.subscribe({ signal: controller.signal }))[Symbol.asyncIterator]()
  t.after(async () => { controller.abort(); await wrapped.return?.() })
  assert.equal((await wrapped.next()).value?.type, "server.connected")
  const failed = wrapped.next()
  f.streams[0].destroy()
  await assert.rejects(failed)
  assert.notEqual((await f.service.acquire()).client, f.client)
})

test("an obsolete iterator cannot invalidate its replacement connection or publish queued events", async t => {
  const f = await transport(t)
  const controller = new AbortController()
  const wrapped = (await f.service.subscribe({ signal: controller.signal }))[Symbol.asyncIterator]()
  t.after(async () => { controller.abort(); await wrapped.return?.() })
  assert.equal((await wrapped.next()).value?.type, "server.connected")
  f.service.invalidate()
  const replacement = await f.service.acquire()
  await assert.rejects(wrapped.next())
  assert.equal(await f.service.acquire(), replacement)
})
