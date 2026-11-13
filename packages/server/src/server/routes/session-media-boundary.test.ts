import assert from "node:assert/strict"
import { test } from "node:test"
import { EventEmitter } from "node:events"
import { get } from "node:http"
import { setImmediate } from "node:timers/promises"
import Fastify, { type FastifyInstance } from "fastify"
import { registerSessionMediaRoutes } from "./session-media"
import { mediaDigest } from "../../opencode/session-media"
import { OpenCodeSharedService } from "../../workspaces/opencode-service"
import { rememberRuntime } from "../../opencode/compatibility/runtime"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64")
const uri = `data:image/png;base64,${bytes.toString("base64")}`

async function fixture(stage: string) {
  const app = Fastify(), upstream = Fastify(), events: string[] = [], entered = deferred(), released = deferred(), closed = deferred()
  const occurrence = new AbortController()
  let generation = 1, sessionReads = 0, ownershipReads = 0, lateSends = 0, ended = 0
  upstream.addHook("onSend", async (_request, reply, payload) => { reply.header("connection", "close"); return payload })
  async function hold(phase: string) {
    events.push(phase)
    if (phase === stage) { entered.resolve(); await released.promise }
  }
  upstream.get("/api/session/s", async () => { await hold(`session${++sessionReads}`); return { data: { id: "s", location: { directory: "/opaque/%/repo" } } } })
  upstream.get("/api/session/s/message/m", async () => {
    await hold("message")
    return { data: { id: "m", type: "assistant", content: [{ type: "tool", state: { content: [{ type: "file", mime: "image/png", uri }] } }] } }
  })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const endpoint = { url: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`, auth: { type: "basic" as const, username: "fixture", password: "fixture" } }
  rememberRuntime(endpoint, { version: "2.2.3", pid: 1, discovery: "info" })
  const service = new OpenCodeSharedService()
  await service.endpoint({ kind: "lifecycle", identity: "media-boundary", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
  const connection = await service.acquire()
  registerSessionMediaRoutes(app, { workspaceManager: {
    captureWorkspaceOperation: (id: string) => {
      assert.equal(id, "lab~same")
      const captured = generation
      return { signal: occurrence.signal, current: () => { occurrence.signal.throwIfAborted(); assert.equal(generation, captured); return true } }
    },
    getSharedServiceConnection: async () => { await hold("acquire"); return connection },
    ownsLocation: async (_id: string, location: unknown, _client: unknown, signal: AbortSignal) => {
      assert.deepEqual(location, { directory: "/opaque/%/repo" }); assert(signal)
      await hold(`owns${++ownershipReads}`); return true
    },
  } as any })
  app.addHook("onSend", async (request, reply, payload) => {
    if (reply.raw.destroyed || request.raw.aborted) lateSends++
    return payload
  })
  app.addHook("onRequest", (request, reply, done) => {
    reply.raw.once("close", closed.resolve)
    const end = reply.raw.end
    reply.raw.end = function (this: typeof reply.raw, ...args: any[]) { if (reply.raw.destroyed || request.raw.aborted) lateSends++; ended++; return end.apply(this, args as any) } as typeof end
    done()
  })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
  const path = `/api/workspaces/lab~same/session-media/s/m/0/0/${mediaDigest(uri)}`
  return { app, origin, path, events, entered, released, closed, occurrence, service, connection,
    replace: () => { generation++; occurrence.abort(); generation++ },
    counts: () => ({ lateSends, ended }),
    close: async () => { released.resolve(); await service.shutdown(); await app.close(); await upstream.close() } }
}

test("route rejects delete/reinsert ABA at every acquisition, SDK and ownership await without the next effect", async () => {
  const phases = ["acquire", "session1", "owns1", "message", "session2", "owns2"]
  for (const stage of phases) {
    const f = await fixture(stage)
    let request: ReturnType<typeof get> | undefined
    try {
      const finished = new Promise<void>(resolve => {
        request = get(f.origin + f.path, response => { response.resume(); response.on("end", resolve) })
        request.on("error", () => resolve()); request.on("close", resolve)
      })
      await f.entered.promise
      const prefix = [...f.events]
      f.replace()
      await finished
      f.released.resolve()
      await setImmediate(); await setImmediate()
      assert.deepEqual(f.events, prefix, stage)
      assert.deepEqual(f.counts(), { lateSends: 0, ended: 0 }, stage)
      f.connection.assertCurrent()
    } finally { request?.destroy(); await f.close() }
  }
})

test("client close at every await suppresses errors and all later writes without retiring the connection", async () => {
  for (const stage of ["acquire", "session1", "owns1", "message", "session2", "owns2"]) {
    const f = await fixture(stage)
    let request: ReturnType<typeof get> | undefined
    try {
      const finished = new Promise<void>(resolve => {
        request = get(f.origin + f.path, response => response.resume())
        request.on("error", () => resolve()); request.on("close", resolve)
      })
      await f.entered.promise
      const prefix = [...f.events]
      request!.destroy()
      await finished
      await f.closed.promise
      f.released.resolve()
      await setImmediate(); await setImmediate()
      assert.deepEqual(f.events, prefix, stage)
      assert.deepEqual(f.counts(), { lateSends: 0, ended: 0 }, stage)
      f.connection.assertCurrent()
    } finally { request?.destroy(); await f.close() }
  }
})

test("one total 30-second budget includes held acquisition and preserves another shared waiter", async t => {
  const f = await fixture("acquire")
  let request: ReturnType<typeof get> | undefined
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const finished = new Promise<void>(resolve => {
      request = get(f.origin + f.path, response => response.resume())
      request.on("error", () => resolve()); request.on("close", resolve)
    })
    await f.entered.promise
    t.mock.timers.tick(29_999)
    assert.deepEqual(f.counts(), { lateSends: 0, ended: 0 })
    t.mock.timers.tick(1)
    await finished
    f.released.resolve()
    await setImmediate()
    assert.deepEqual(f.events, ["acquire"])
    assert.deepEqual(f.counts(), { lateSends: 0, ended: 0 })
    assert.equal(await f.service.acquire(), f.connection)
  } finally { t.mock.timers.reset(); request?.destroy(); await f.close() }
})

test("closed admission cannot send even a malformed 400, missing-workspace 404 or catch error", async () => {
  let handler!: (request: any, reply: any) => Promise<unknown>
  const app = { get: (_path: string, callback: typeof handler) => { handler = callback } } as unknown as FastifyInstance
  registerSessionMediaRoutes(app, { workspaceManager: { captureWorkspaceOperation() { assert.fail("closed admission must stop before capture") } } as any })
  for (const url of ["/bad", `/api/workspaces/gone/session-media/s/m/0/0/${"a".repeat(64)}`]) {
    const raw = Object.assign(new EventEmitter(), { destroyed: true, closed: true, destroy() {} })
    const reply = { raw, hijack() { return reply }, code() { assert.fail("no code after close") }, send() { assert.fail("no send after close") } }
    await handler({ url, raw: { aborted: true } }, reply)
    assert.equal(raw.listenerCount("close"), 0)
  }
})

test("a valid prefixed raw workspace performs exactly three SDK GETs in order and serves the PNG", async () => {
  const f = await fixture("none")
  try {
    const response = await fetch(f.origin + f.path)
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    assert.deepEqual(f.events, ["acquire", "session1", "owns1", "message", "session2", "owns2"])
    assert.deepEqual(f.counts(), { lateSends: 0, ended: 1 })
    f.connection.assertCurrent()
  } finally { await f.close() }
})
