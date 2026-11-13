import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { OpenCodeSharedService } from "../workspaces/opencode-service"
import { rememberRuntime } from "./compatibility/runtime"
import { createSessionMediaFetch } from "./session-media-fetch"
import { MESSAGE_LIMIT } from "./session-media-contract"
import { createServer } from "node:http"
import { gzipSync, brotliCompressSync, deflateSync } from "node:zlib"

async function connected() {
  const endpoint = { url: "http://127.0.0.1:4321", auth: { type: "basic" as const, username: "media", password: "fixture" } }
  rememberRuntime(endpoint, { version: "2.2.3", pid: 1, discovery: "info" })
  const service = new OpenCodeSharedService()
  await service.endpoint({ kind: "lifecycle", identity: "bounded-media", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
  return { service, connection: await service.acquire() }
}

test("media processor receives the original non-JSON error before compatibility cancellation", async t => {
  const endpoint = { url: "http://127.0.0.1:4321" }
  rememberRuntime(endpoint, { version: "2.2.3", pid: 1, discovery: "info" })
  let cancel = 0, processed = 0, release!: () => void
  const cleanup = new Promise<void>(resolve => { release = resolve })
  const original = new Response(new ReadableStream({ cancel() { cancel++; return cleanup } }), { status: 400 })
  t.mock.method(globalThis, "fetch", async () => original)
  const service = new OpenCodeSharedService()
  await service.endpoint({ kind: "lifecycle", identity: "media-test", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
  const connection = await service.acquire()
  const pending = connection.fetch(`${endpoint.url}/api/session/s`, undefined, async response => {
    processed++
    assert.equal(response, original)
    assert.equal(cancel, 0)
    return new Response("bounded", { status: 400 })
  })
  void pending.catch(() => {})
  try {
    await setImmediate()
    assert.equal(processed, 1)
    assert.equal(cancel, 0, "compatibility may cancel only the returned memory response")
    assert.equal((await pending).status, 400)
  } finally {
    release()
    await pending.catch(() => {})
    await service.shutdown()
  }
})

test("ordinary non-JSON errors still await their sole cancel and preserve its rejection", async t => {
  const endpoint = { url: "http://127.0.0.1:4321" }
  rememberRuntime(endpoint, { version: "2.2.3", pid: 1, discovery: "info" })
  let cancel = 0, reject!: (error: Error) => void, settled = false
  const cleanup = new Promise<void>((_, fail) => { reject = fail })
  const failure = new Error("original cancel rejected")
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ cancel() { cancel++; return cleanup } }), { status: 400 }))
  const service = new OpenCodeSharedService()
  await service.endpoint({ kind: "lifecycle", identity: "ordinary-test", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
  const connection = await service.acquire()
  const pending = connection.fetch(`${endpoint.url}/api/session/s`)
  void pending.then(() => { settled = true }, () => { settled = true })
  try {
    await setImmediate()
    assert.equal(cancel, 1)
    assert.equal(settled, false)
    reject(failure)
    await assert.rejects(pending, error => error === failure)
  } finally { reject(failure); await pending.catch(() => {}); await service.shutdown() }
})

test("media counts every decompressed byte before retention on success, JSON and non-JSON errors", async t => {
  const f = await connected()
  try {
    for (const status of [200, 400, 404, 500]) for (const type of ["application/json", "text/plain"]) for (const delta of [-1, 0, 1]) for (const chunked of [false, true]) {
      const size = MESSAGE_LIMIT + delta
      let sent = 0, cancelled = 0, calls = 0
      const response = new Response(new ReadableStream({
        pull(controller) {
          if (sent === size) { controller.close(); return }
          const length = Math.min(chunked ? 65537 : size, size - sent)
          controller.enqueue(new Uint8Array(length).fill(32)); sent += length
        }, cancel() { cancelled++ },
      }, { highWaterMark: 0 }), { status, headers: { "content-type": type, "content-length": delta === 0 ? "999999999" : "1", "content-encoding": "gzip", "x-fixture": "retained" } })
      t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls++
        assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("media:fixture").toString("base64")}`)
        assert.equal(init?.redirect, "error")
        return response
      })
      const fetch = createSessionMediaFetch(f.connection, new AbortController().signal, () => {})
      const pending = fetch(`${f.connection.endpoint.url}/api/session/s`)
      if (delta === 1) { await assert.rejects(pending, /Media response limit/); assert.equal(cancelled, 1) }
      else {
        const result = await pending
        assert.equal(result.status, status)
        if (status === 200 || type === "application/json") {
          assert.equal(result.headers.get("content-encoding"), null)
          assert.equal(result.headers.get("content-length"), null)
          assert.equal(result.headers.get("x-fixture"), "retained")
          assert.equal((await result.arrayBuffer()).byteLength, size)
        } else assert.equal((await result.json())._tag, "OpenCodeContractError")
        assert.equal(cancelled, 0)
      }
      assert.equal(response.body?.locked, false)
      assert.equal(calls, 1)
      t.mock.restoreAll()
    }
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }))
    const response = await createSessionMediaFetch(f.connection, new AbortController().signal, () => {})(`${f.connection.endpoint.url}/api/session/s`)
    assert.equal(response.body, null)
  } finally { await f.service.shutdown() }
})

test("held original non-JSON read/cancel never holds the media abort, and late rejection stays observed", async t => {
  const f = await connected(), abort = new AbortController()
  let cancelled = 0, reject!: (error: Error) => void
  const cleanup = new Promise<void>((_, fail) => { reject = fail })
  const original = new Response(new ReadableStream({ cancel() { cancelled++; return cleanup } }), { status: 400 })
  t.mock.method(globalThis, "fetch", async () => original)
  let parses = 0
  t.mock.method(original, "json", async () => { parses++; assert.fail("original must not parse") })
  t.mock.method(original, "clone", () => { assert.fail("original must not clone") })
  const unhandled: unknown[] = [], onUnhandled = (error: unknown) => { unhandled.push(error) }
  process.on("unhandledRejection", onUnhandled)
  try {
    const client = OpenCode.make({ baseUrl: f.connection.endpoint.url, fetch: createSessionMediaFetch(f.connection, abort.signal, () => {}) })
    const pending = client.session.get({ sessionID: "s" })
    const check = assert.rejects(pending, (error: any) => error.cause === abort.signal.reason || error.reason?.cause === abort.signal.reason)
    await setImmediate()
    abort.abort(new Error("media observer left"))
    await check
    assert.equal(cancelled, 1)
    assert.equal(original.body?.locked, false)
    assert.equal(parses, 0)
    reject(new Error("late cleanup rejection"))
    await setImmediate()
    assert.deepEqual(unhandled, [])
    f.connection.assertCurrent()
  } finally { reject(new Error("teardown")); process.removeListener("unhandledRejection", onUnhandled); await f.service.shutdown() }
})

test("late headers are cleaned once after observer cancellation; an unrelated waiter stays usable", async t => {
  const f = await connected(), abort = new AbortController()
  let resolve!: (response: Response) => void, cancelled = 0
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => new URL(String(input)).pathname.endsWith("/held")
    ? new Promise<Response>(done => { resolve = done }) : Response.json({ data: { id: "other" } }))
  try {
    const fetch = createSessionMediaFetch(f.connection, abort.signal, () => {})
    const pending = fetch(`${f.connection.endpoint.url}/api/session/held`)
    const check = assert.rejects(pending, { name: "AbortError" })
    await setImmediate(); abort.abort(); await check
    assert.equal((await f.connection.client.session.get({ sessionID: "other" })).id, "other")
    const original = new Response(new ReadableStream({ cancel() { cancelled++; return Promise.reject(new Error("late cancel")) } }))
    resolve(original)
    await setImmediate(); await setImmediate()
    assert.equal(cancelled, 1)
    assert.equal(original.body?.locked, false)
    f.connection.assertCurrent()
  } finally { await f.service.shutdown() }
})

test("real loopback gzip, br and deflate bodies obey the decompressed limit for success and errors", async () => {
  let body = Buffer.alloc(0), encoding = "gzip", status = 200, count = 0
  const server = createServer((_request, response) => {
    count++
    response.writeHead(status, { "content-type": "application/json", "content-encoding": encoding, "content-length": body.length })
    response.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const endpoint = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
  rememberRuntime(endpoint, { version: "2.2.3", pid: 1, discovery: "info" })
  const service = new OpenCodeSharedService()
  try {
    await service.endpoint({ kind: "lifecycle", identity: "compressed-media", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
    const connection = await service.acquire()
    const fetch = createSessionMediaFetch(connection, new AbortController().signal, () => {})
    for (const codec of ["gzip", "br", "deflate"]) for (const code of [200, 400, 500]) for (const delta of [-1, 0, 1]) {
      encoding = codec; status = code
      const raw = Buffer.alloc(MESSAGE_LIMIT + delta, 32)
      body = codec === "gzip" ? gzipSync(raw) : codec === "br" ? brotliCompressSync(raw) : deflateSync(raw)
      const pending = fetch(`${endpoint.url}/api/session/s`)
      if (delta === 1) await assert.rejects(pending, /Media response limit/)
      else {
        const response = await pending
        assert.equal(response.status, code)
        assert.equal(response.headers.get("content-encoding"), null)
        assert.equal(response.headers.get("content-length"), null)
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), raw)
      }
    }
    assert.equal(count, 27)
  } finally { await service.shutdown(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

test("official SDK parses only the bounded memory copy once; body errors preserve their cause", async t => {
  const f = await connected()
  const originalParse = JSON.parse
  let parses = 0
  t.mock.method(JSON, "parse", (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => { parses++; return originalParse(text, reviver) })
  let response = Response.json({ data: { id: "s", location: { directory: "/exact/%/工作" } } })
  t.mock.method(response, "json", () => { assert.fail("original must not parse") })
  t.mock.method(response, "text", () => { assert.fail("original must not decode") })
  t.mock.method(globalThis, "fetch", async () => response)
  const client = OpenCode.make({ baseUrl: f.connection.endpoint.url, fetch: createSessionMediaFetch(f.connection, new AbortController().signal, () => {}) })
  try {
    assert.deepEqual(await client.session.get({ sessionID: "s" }), { id: "s", location: { directory: "/exact/%/工作" } })
    assert.equal(parses, 1)
    const failure = new Error("original reader failed")
    response = new Response(new ReadableStream({ pull(controller) { controller.error(failure) } }))
    await assert.rejects(client.session.get({ sessionID: "s" }), (error: any) => error.cause === failure)
    assert.equal(response.body?.locked, false)
    assert.equal(parses, 1)
  } finally { await f.service.shutdown() }
})

test("headers arriving already aborted and a connection retired during body consumption clean only the old reader", async t => {
  for (const phase of ["headers", "body"]) {
    const f = await connected(), abort = new AbortController()
    let cancelled = 0, opened!: () => void
    const entered = new Promise<void>(resolve => { opened = resolve })
    const response = new Response(new ReadableStream({ pull() { opened() }, cancel() { cancelled++ } }))
    t.mock.method(globalThis, "fetch", async () => { if (phase === "headers") abort.abort(); return response })
    try {
      const pending = createSessionMediaFetch(f.connection, abort.signal, () => {})(`${f.connection.endpoint.url}/api/session/s`)
      const checked = assert.rejects(pending)
      if (phase === "body") {
        await entered
        await setImmediate()
        f.service.invalidate()
      }
      await checked
      await setImmediate()
      assert.equal(cancelled, 1)
      assert.equal(response.body?.locked, false)
      const next = await f.service.acquire()
      next.assertCurrent()
      assert.equal(await f.service.acquire(), next)
    } finally { t.mock.restoreAll(); await f.service.shutdown() }
  }
})

test("real fragmented gzip non-JSON errors bound decompressed bytes before normalization", async () => {
  let body = Buffer.alloc(0), requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(500, { "content-type": "text/plain", "content-encoding": "gzip" })
    for (let offset = 0; offset < body.length; offset += 97) response.write(body.subarray(offset, offset + 97))
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const endpoint = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
  rememberRuntime(endpoint, { version: "2.2.3", pid: 1, discovery: "info" })
  const service = new OpenCodeSharedService()
  try {
    await service.endpoint({ kind: "lifecycle", identity: "gzip-error-boundary", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
    const fetch = createSessionMediaFetch(await service.acquire(), new AbortController().signal, () => {})
    for (const delta of [-1, 0, 1]) {
      body = gzipSync(Buffer.alloc(MESSAGE_LIMIT + delta, 120))
      let dependent = 0
      const pending = fetch(`${endpoint.url}/api/session/s`).then(response => { dependent++; return response })
      if (delta === 1) { await assert.rejects(pending, /Media response limit/); assert.equal(dependent, 0) }
      else {
        const response = await pending
        assert.equal(response.status, 500)
        assert.equal((await response.json())._tag, "OpenCodeContractError")
        assert.equal(dependent, 1)
      }
    }
    assert.equal(requests, 3)
  } finally { await service.shutdown(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

test("real under/overdeclared and absent HTTP length obey framing or reject before dependent work", async () => {
  let mode = "none", requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(200, { "content-type": "application/json", connection: "close",
      ...(mode === "none" ? {} : { "content-length": mode === "under" ? "2" : "100" }) })
    response.end('{"data":{"id":"s"}}')
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const endpoint = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
  rememberRuntime(endpoint, { version: "2.2.3", pid: 1, discovery: "info" })
  const service = new OpenCodeSharedService()
  try {
    await service.endpoint({ kind: "lifecycle", identity: "framing-boundary", lifecycle: { discover: async () => endpoint, ensure: async () => endpoint } })
    const fetch = createSessionMediaFetch(await service.acquire(), new AbortController().signal, () => {})
    for (const framing of ["none", "under", "over"]) {
      mode = framing
      let dependent = 0
      const pending = fetch(`${endpoint.url}/api/session/s`).then(response => { dependent++; return response })
      if (framing === "over") { await assert.rejects(pending); assert.equal(dependent, 0) }
      else {
        const response = await pending
        assert.equal(response.headers.get("content-length"), null)
        assert.equal(await response.text(), framing === "under" ? '{"' : '{"data":{"id":"s"}}')
        assert.equal(dependent, 1)
      }
    }
    assert.equal(requests, 3)
  } finally { await service.shutdown(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
