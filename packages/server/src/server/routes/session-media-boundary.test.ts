import assert from "node:assert/strict"
import test from "node:test"
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib"
import { imageUri, latch, mediaFixture, nativeMessage, png } from "./session-media-fixture"

const LIMIT = 16 * 1024 * 1024
function envelope(size: number) {
  const base = JSON.stringify({ data: nativeMessage(), padding: "" })
  return base.slice(0, -2) + " ".repeat(size - Buffer.byteLength(base)) + '"}'
}

test("real manager + official media client: whole-envelope ceiling rejects +1 before serving even a small valid image", async t => {
  const f = await mediaFixture(t)
  const from = Buffer.from
  let decoded = 0
  t.mock.method(Buffer, "from", ((value: any, ...args: any[]) => {
    if (args[0] === "base64") decoded++
    return (from as any)(value, ...args)
  }) as typeof Buffer.from)
  f.respond(response => response.end(envelope(LIMIT + 1)))
  const result = await f.app.inject(f.url())
  assert.equal(result.statusCode, 502)
  assert.deepEqual(result.json(), { error: "Media unavailable" })
  assert.equal(decoded, 0, "overflow never reaches base64 decoding")
})

test("media route refuses active/unqualified images, malformed base64 and URI overflow without modifying native files", async t => {
  const f = await mediaFixture(t)
  for (const [mime, uri] of [
    ["image/svg+xml", "data:image/svg+xml;base64,PHN2Zy8+"],
    ["image/bmp", "data:image/bmp;base64,eA=="],
    ["image/png", "data:image/png;base64,eB=="],
    ["image/png", "data:image/png;base64,eA="],
    ["image/png", "data:image/png;base64,eA==\n"],
    ["image/png", "data:image/jpeg;base64,eA=="],
    ["image/png", "data:image/png;base64," + "A".repeat(8 * 1024 * 1024)],
  ]) {
    const message = nativeMessage(uri, mime), before = structuredClone(message)
    f.message(message)
    assert.equal((await f.app.inject(f.url(f.a.id, uri))).statusCode, 404, mime)
    assert.deepEqual(message, before)
  }
})

for (const size of [LIMIT - 1, LIMIT]) test(`whole decompressed envelope ${size} bytes succeeds, including unrelated metadata`, async t => {
  const f = await mediaFixture(t)
  f.respond(response => { response.setHeader("content-length", size); response.end(envelope(size)) })
  const result = await f.app.inject(f.url())
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.rawPayload, png)
})

for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]] as const) {
  test(`${encoding}: an exact-limit decoded envelope serves the intact image without double decompression`, async t => {
    const f = await mediaFixture(t), compressed = compress(Buffer.from(envelope(LIMIT)))
    f.respond(response => { response.setHeader("content-encoding", encoding); response.setHeader("content-length", compressed.byteLength); response.end(compressed) })
    const result = await f.app.inject(f.url())
    assert.equal(result.statusCode, 200)
    assert.deepEqual(result.rawPayload, png)
  })
  for (const status of [200, 500]) test(`${encoding} ${status}: a tiny compressed envelope expanding past 16 MiB fails closed`, async t => {
    const f = await mediaFixture(t)
    const compressed = compress(Buffer.from(envelope(LIMIT + 1)))
    assert(compressed.byteLength < LIMIT / 100)
    f.respond(response => { response.statusCode = status; response.setHeader("content-encoding", encoding); response.setHeader("content-length", compressed.byteLength); response.end(compressed) })
    const result = await f.app.inject(f.url())
    assert.equal(result.statusCode, 502)
    assert.deepEqual(result.json(), { error: "Media unavailable" })
  })
}

test("real chunked success/error overflow cancels upstream while it still has a body outstanding", async t => {
  const f = await mediaFixture(t)
  for (const status of [200, 500]) {
    const closed = latch()
    f.respond(response => {
      response.statusCode = status
      response.once("close", closed.resolve)
      response.write(envelope(LIMIT + 1)) // deliberately never end the body
    })
    const result = await f.app.inject(f.url())
    assert.equal(result.statusCode, 502)
    await closed.promise
  }
})

test("malformed JSON, empty bodies and invalid HTTP errors return sanitized failures", async t => {
  const f = await mediaFixture(t)
  for (const [status, body] of [[200, "{"], [200, ""], [204, ""], [500, "fixture-private-body"], [500, '{"_tag":"SessionNotFoundError","message":"private"}']] as const) {
    f.respond(response => { response.statusCode = status; response.end(body) })
    const result = await f.app.inject(f.url())
    assert.equal(result.statusCode, 502)
    assert.deepEqual(result.json(), { error: "Media unavailable" })
  }
})

test("metadata reads have the same HTTP envelope ceiling", async t => {
  const f = await mediaFixture(t)
  f.respondSession(response => response.end(JSON.stringify({ data: { id: "s", location: { directory: f.a.path } }, pad: " ".repeat(LIMIT) })))
  assert.equal((await f.app.inject(f.url())).statusCode, 502)
  assert.equal(f.calls.filter(call => call.path.includes("/message/")).length, 0)
})

test("canonical positions/identities, digest, exact opaque placement and revert remain authoritative", async t => {
  const f = await mediaFixture(t)
  assert.deepEqual((await f.app.inject(f.url())).rawPayload, png)
  for (const [part, index] of [["00", "0"], ["0", "00"], ["-1", "0"], ["9999999", "0"]]) assert.equal((await f.app.inject(f.url(f.a.id, imageUri, part, index))).statusCode, 400)
  assert.equal((await f.app.inject(f.url(f.b.id))).statusCode, 404, "a homonymous message on B has other bytes")
  assert.equal((await f.app.inject(f.url().replace(/[^/]+$/, "0".repeat(64)))).statusCode, 404)
  f.session({ id: "other", location: { directory: f.a.path } })
  assert.equal((await f.app.inject(f.url())).statusCode, 403)
  f.session({ id: "s", location: { directory: f.a.path, workspaceID: "internal" } })
  assert.equal((await f.app.inject(f.url())).statusCode, 403)
  f.session({ id: "s", location: { directory: f.a.path.toLowerCase() } })
  assert.equal((await f.app.inject(f.url())).statusCode, 403)
  f.session({ id: "s", location: { directory: f.a.path }, revert: { messageID: "m" } })
  assert.equal((await f.app.inject(f.url())).statusCode, 404)
  f.session({ id: "s", location: { directory: f.a.path } })
  f.afterMessage(() => f.session({ id: "s", location: { directory: "/moved" } }))
  assert.equal((await f.app.inject(f.url())).statusCode, 409)
})

for (const revoke of ["rotate", "disconnect", "close"] as const) test(`stalled body: ${revoke} cancels captured transport with no replacement read or publication`, async t => {
  const f = await mediaFixture(t), entered = latch(), closed = latch()
  f.respond(response => { response.once("close", closed.resolve); response.write('{"data":'); entered.resolve() })
  const pending = f.app.inject(f.url())
  await entered.promise
  const before = f.calls.length
  if (revoke === "rotate") await f.credentials.set("A", JSON.stringify({ username: "new", password: "synthetic" }))
  if (revoke === "disconnect") f.connections.disconnect("A")
  if (revoke === "close") await f.manager.delete(f.a.id)
  assert.equal((await pending).statusCode, 502)
  await closed.promise
  assert.equal(f.calls.length, before)
})

test("revocation before dispatch rejects before acquisition, and B/local remain readable", async t => {
  const f = await mediaFixture(t)
  f.connections.disconnect("A")
  const before = f.calls.length
  assert.equal((await f.app.inject(f.url())).statusCode, 403)
  assert.equal(f.calls.length, before)
  assert.equal((await f.app.inject(f.url(f.b.id, `data:image/png;base64,${Buffer.from("B").toString("base64")}`))).statusCode, 200)
  assert.deepEqual((await f.app.inject(f.url(f.local.id))).rawPayload, png)
})

test("shared-local body has the same bound and aborts on its workspace lifetime", async t => {
  const f = await mediaFixture(t), entered = latch(), closed = latch()
  f.respond(response => response.end(envelope(LIMIT + 1)))
  assert.equal((await f.app.inject(f.url(f.local.id))).statusCode, 502)
  f.respond(response => { response.once("close", closed.resolve); response.write('{"data":'); entered.resolve() })
  const pending = f.app.inject(f.url(f.local.id))
  await entered.promise
  f.localLife.abort()
  assert.equal((await pending).statusCode, 502)
  await closed.promise
})

test("client socket close cancels a stalled upstream without trying to send an error afterward", async t => {
  const f = await mediaFixture(t), entered = latch(), closed = latch()
  let sent = 0
  f.app.addHook("onSend", async () => { sent++ })
  f.respond(response => { response.once("close", closed.resolve); response.write('{"data":'); entered.resolve() })
  const origin = await f.app.listen({ host: "127.0.0.1", port: 0 })
  const controller = new AbortController()
  const rejected = assert.rejects(fetch(origin + f.url(), { signal: controller.signal }), { name: "AbortError" })
  await entered.promise
  controller.abort()
  await rejected
  await closed.promise
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent, 0)
})

test("30-second route deadline cancels a genuinely stalled body, not just its eventual publication", async t => {
  const f = await mediaFixture(t), closed = latch()
  f.respond(response => { response.once("close", closed.resolve); response.write('{"data":') })
  const result = await f.app.inject(f.url())
  assert.equal(result.statusCode, 502)
  await closed.promise
})

test("missing captured transport never falls back to any shared client", async t => {
  const f = await mediaFixture(t)
  t.mock.method(f.manager, "getSharedServiceConnection", async () => undefined)
  const before = f.calls.length
  for (const id of [f.a.id, f.local.id]) assert.equal((await f.app.inject(f.url(id))).statusCode, 503)
  assert.equal(f.calls.length, before)
})

test("cancelled acquisition releases its observer before shared work settles and cannot dispatch late", async t => {
  const f = await mediaFixture(t), entered = latch()
  const captured = await f.manager.getSharedServiceConnection(f.local.id)
  let finish!: () => void
  const held = new Promise<typeof captured>(resolve => { finish = () => resolve(captured) })
  t.mock.method(f.manager, "getSharedServiceConnection", async () => { entered.resolve(); return held })
  const before = f.calls.length, pending = f.app.inject(f.url(f.local.id))
  await entered.promise
  f.localLife.abort()
  assert.equal((await pending).statusCode, 502)
  finish()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.length, before)
})

test("client close during acquisition retires its observer while preserving shared owner work", async t => {
  const f = await mediaFixture(t), entered = latch(), closed = latch()
  const captured = await f.manager.getSharedServiceConnection(f.local.id)
  let finish!: () => void, sent = 0
  const held = new Promise<typeof captured>(resolve => { finish = () => resolve(captured) })
  t.mock.method(f.manager, "getSharedServiceConnection", async () => { entered.resolve(); return held })
  f.app.addHook("onSend", async () => { sent++ })
  f.app.addHook("onRequest", async (_request, reply) => { reply.raw.once("close", closed.resolve) })
  const origin = await f.app.listen({ host: "127.0.0.1", port: 0 }), controller = new AbortController()
  const before = f.calls.length
  const rejected = assert.rejects(fetch(origin + f.url(f.local.id), { signal: controller.signal }), { name: "AbortError" })
  await entered.promise
  controller.abort()
  await rejected
  await closed.promise
  finish()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent, 0)
  assert.equal(f.calls.length, before)
})

test("30-second deadline bounds an observer waiting on shared acquisition without dispatching after it settles", async t => {
  const f = await mediaFixture(t)
  const captured = await f.manager.getSharedServiceConnection(f.local.id)
  let finish!: () => void
  const held = new Promise<typeof captured>(resolve => { finish = () => resolve(captured) })
  t.mock.method(f.manager, "getSharedServiceConnection", async () => held)
  const before = f.calls.length
  assert.equal((await f.app.inject(f.url(f.local.id))).statusCode, 502)
  finish()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.length, before)
})

test("shared-local trusted image formats retain their existing sandboxed serving policy", async t => {
  const f = await mediaFixture(t)
  const uri = "data:image/svg+xml;base64,PHN2Zy8+"
  f.message(nativeMessage(uri, "image/svg+xml"))
  const local = await f.app.inject(f.url(f.local.id, uri))
  assert.equal(local.statusCode, 200)
  assert.equal(local.headers["content-security-policy"], "default-src 'none'; sandbox")
  assert.equal((await f.app.inject(f.url(f.a.id, uri))).statusCode, 404)
})

test("an already-closed downstream request cannot acquire or dispatch when its handler is admitted late", async t => {
  const f = await mediaFixture(t), entered = latch(), closed = latch()
  let captures = 0
  const acquire = f.manager.getSharedServiceConnection.bind(f.manager)
  t.mock.method(f.manager, "getSharedServiceConnection", async (id: string) => { captures++; return acquire(id) })
  f.app.addHook("preHandler", async (_request, reply) => {
    reply.raw.once("close", closed.resolve)
    entered.resolve()
    await closed.promise
  })
  const origin = await f.app.listen({ host: "127.0.0.1", port: 0 }), controller = new AbortController()
  const rejected = assert.rejects(fetch(origin + f.url(), { signal: controller.signal }), { name: "AbortError" })
  await entered.promise
  controller.abort()
  await rejected
  await closed.promise
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(captures, 0)
})

for (const path of ["invalid-reference", "missing-workspace"]) test(`closed late handler: ${path} publishes no response or raw write`, async t => {
  const f = await mediaFixture(t), entered = latch(), closed = latch(), handled = latch()
  let sent = 0, ended = 0, written = 0, captures = 0
  const acquire = f.manager.getSharedServiceConnection.bind(f.manager)
  t.mock.method(f.manager, "getSharedServiceConnection", async (id: string) => { captures++; return acquire(id) })
  f.app.addHook("onSend", async () => { sent++ })
  f.app.addHook("preHandler", async (_request, reply) => {
    reply.raw.once("close", closed.resolve)
    entered.resolve()
    await closed.promise
    const end = reply.raw.end.bind(reply.raw), write = reply.raw.write.bind(reply.raw)
    reply.raw.end = ((...args: any[]) => { ended++; return (end as any)(...args) }) as typeof reply.raw.end
    reply.raw.write = ((...args: any[]) => { written++; return (write as any)(...args) }) as typeof reply.raw.write
    setImmediate(() => setImmediate(handled.resolve))
  })
  const origin = await f.app.listen({ host: "127.0.0.1", port: 0 }), controller = new AbortController()
  const url = path === "invalid-reference" ? f.url().replace("/0/0/", "/00/0/") : f.url("missing")
  const rejected = assert.rejects(fetch(origin + url, { signal: controller.signal }), { name: "AbortError" })
  await entered.promise
  controller.abort()
  await rejected
  await closed.promise
  await handled.promise
  assert.deepEqual({ sent, ended, written, captures }, { sent: 0, ended: 0, written: 0, captures: 0 })
})

test("open requests retain ordinary 400/404/capability responses and the positive local image", async t => {
  const f = await mediaFixture(t)
  assert.equal((await f.app.inject(f.url().replace("/0/0/", "/00/0/"))).statusCode, 400)
  assert.equal((await f.app.inject(f.url("missing"))).statusCode, 404)
  f.connections.disconnect("A")
  assert.equal((await f.app.inject(f.url())).statusCode, 403)
  assert.deepEqual((await f.app.inject(f.url(f.local.id))).rawPayload, png)
})
