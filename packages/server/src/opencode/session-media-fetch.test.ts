import assert from "node:assert/strict"
import test from "node:test"
import { OpenCode } from "@opencode/client"
import { boundedMediaFetch } from "./session-media-fetch"
import { MESSAGE_LIMIT } from "./session-media-contract"
import { getEventListeners } from "node:events"

function body(size: number, error = false) {
  const base = JSON.stringify(error ? { _tag: "SessionNotFoundError", sessionID: "s", message: "fixture", pad: "" } : { data: { id: "m" }, pad: "" })
  return new TextEncoder().encode(base.slice(0, -2) + " ".repeat(size - base.length) + '"}')
}

for (const status of [200, 404]) {
  for (const size of [MESSAGE_LIMIT - 1, MESSAGE_LIMIT, MESSAGE_LIMIT + 1]) test(`official SDK ${status}/${size}: limit before parser, headers are advisory`, async t => {
    const bytes = body(size, status === 404)
    let cancelled = 0, parsed = 0
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() }, cancel() { cancelled++ } }, { highWaterMark: 0 })
    // Observe the actual SDK's parser rather than replacing its guard or decoder.
    const text = Response.prototype.text
    t.mock.method(Response.prototype, "text", function (this: Response) { parsed++; return text.call(this) })
    const fetch = boundedMediaFetch(async () => new Response(source, { status, headers: { "content-type": "application/json", "content-length": "1" } }), new AbortController().signal, () => {})
    const client = OpenCode.make({ baseUrl: "http://media.invalid", fetch })
    if (size > MESSAGE_LIMIT || status !== 200) await assert.rejects(client.session.message.get({ sessionID: "s", messageID: "m" }))
    else assert.equal((await client.session.message.get({ sessionID: "s", messageID: "m" })).id, "m")
    assert.equal(parsed, size > MESSAGE_LIMIT ? 0 : 1)
    // A closed one-chunk stream is already settled; cancellation is proven below on live streams.
    assert.equal(cancelled, 0)
  })
}

test("overflowing individual chunk and cumulative chunks are cancelled before returning any Response to the SDK", async () => {
  for (const sizes of [[MESSAGE_LIMIT + 1], [MESSAGE_LIMIT, 1], [MESSAGE_LIMIT / 2, MESSAGE_LIMIT / 2, 1]]) {
    let cancelled = 0, reads = 0
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(sizes[reads++])); }, cancel() { cancelled++ } }, { highWaterMark: 0 })
    const fetch = boundedMediaFetch(async () => new Response(stream), new AbortController().signal, () => {})
    await assert.rejects(fetch("http://media.invalid"), /too large/)
    assert.equal(reads, sizes.length)
    assert.equal(cancelled, 1)
    assert.equal(stream.locked, false)
  }
})

test("below/exact limit chunked bodies preserve status, statusText and needed headers without stale encoding/length", async () => {
  for (const size of [MESSAGE_LIMIT - 1, MESSAGE_LIMIT]) {
    let reads = 0
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new Uint8Array(size - 1))
      else { controller.enqueue(Uint8Array.of(42)); controller.close() }
    } })
    const fetch = boundedMediaFetch(async () => new Response(stream, { status: 404, statusText: "Fixture", headers: {
      "content-type": "application/json", "x-fixture": "kept", "content-length": "1", "content-encoding": "gzip", "transfer-encoding": "chunked",
    } }), new AbortController().signal, () => {})
    const response = await fetch("http://media.invalid")
    assert.equal(response.status, 404); assert.equal(response.statusText, "Fixture")
    assert.equal(response.headers.get("content-type"), "application/json")
    assert.equal(response.headers.get("x-fixture"), "kept")
    for (const header of ["content-length", "content-encoding", "transfer-encoding"]) assert.equal(response.headers.get(header), null)
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.equal(bytes.byteLength, size); assert.equal(bytes.at(-1), 42)
  }
})

test("pre-dispatch abort invokes no fetch; abort during a stalled body cancels and releases it", async () => {
  const controller = new AbortController()
  let requests = 0
  const never = boundedMediaFetch(async () => { requests++; return new Response() }, controller.signal, () => {})
  controller.abort()
  await assert.rejects(never("http://media.invalid"), { name: "AbortError" })
  assert.equal(requests, 0)
  for (const fromRequest of [false, true]) {
    const abort = new AbortController()
    let entered!: () => void, cancelled = 0
    const reading = new Promise<void>(resolve => { entered = resolve })
    const stream = new ReadableStream<Uint8Array>({ pull() { entered() }, cancel() { cancelled++ } }, { highWaterMark: 0 })
    const fetch = boundedMediaFetch(async () => new Response(stream), fromRequest ? new AbortController().signal : abort.signal, () => {})
    const pending = fetch(new Request("http://media.invalid", fromRequest ? { signal: abort.signal } : undefined))
    const rejected = assert.rejects(pending, { name: "AbortError" })
    await reading
    abort.abort()
    await rejected
    assert.equal(cancelled, 1); assert.equal(stream.locked, false)
  }
})

test("retired authority after headers cancels upstream; absent body cannot reach SDK parsing", async () => {
  let current = true, cancelled = 0
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++ } })
  const fetch = boundedMediaFetch(async () => { current = false; return new Response(stream) }, new AbortController().signal, () => { if (!current) throw new Error("retired") })
  await assert.rejects(fetch("http://media.invalid"), /retired/)
  assert.equal(cancelled, 1); assert.equal(stream.locked, false)
  const empty = boundedMediaFetch(async () => new Response(null, { status: 204 }), new AbortController().signal, () => {})
  await assert.rejects(empty("http://media.invalid"), /no body/)
})

test("official wire keeps captured base prefix, encoded directory header and per-request options", async () => {
  let requests = 0
  const directory = encodeURIComponent("/opaque Case/🦊")
  const fetch = boundedMediaFetch(async (input, init) => {
    requests++
    assert.equal(String(input), "http://media.invalid/prefix/api/session/%C3%A9t%C3%A9")
    assert.equal(init?.method, "GET")
    assert.equal(new Headers(init?.headers).get("x-opencode-directory"), directory)
    assert.equal(new Headers(init?.headers).get("x-fixture"), "captured")
    assert.equal(init?.signal?.aborted, false)
    return Response.json({ data: { id: "été" } })
  }, new AbortController().signal, () => {})
  const client = OpenCode.make({ baseUrl: "http://media.invalid/prefix", fetch, headers: { "x-opencode-directory": directory } })
  assert.equal((await client.session.get({ sessionID: "été" }, { headers: { "x-fixture": "captured" } })).id, "été")
  assert.equal(requests, 1)
})

test("the ceiling counts UTF-8 bytes rather than string characters", async () => {
  const text = "🦊".repeat(MESSAGE_LIMIT / 4 + 1)
  assert(text.length < MESSAGE_LIMIT)
  const fetch = boundedMediaFetch(async () => new Response(text), new AbortController().signal, () => {})
  await assert.rejects(fetch("http://media.invalid"), /too large/)
})

for (const reason of ["overflow", "abort"]) for (const rejectCleanup of [false, true]) {
  test(`${reason}: observer releases reader and listeners before held cancellation ${rejectCleanup ? "rejects" : "resolves"}`, async () => {
    const abort = new AbortController()
    let entered!: () => void, cancelled!: () => void, finish!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    const cancelling = new Promise<void>(resolve => { cancelled = resolve })
    const cleanup = new Promise<void>((resolve, reject) => { finish = () => rejectCleanup ? reject(new Error("Late cleanup failure")) : resolve() })
    let cancelCalls = 0, settled = false, requestSignal!: AbortSignal
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        entered()
        if (reason === "overflow") controller.enqueue(new Uint8Array(MESSAGE_LIMIT + 1))
      },
      cancel() { cancelCalls++; cancelled(); return cleanup },
    }, { highWaterMark: 0 })
    const fetch = boundedMediaFetch(async (_input, init) => {
      requestSignal = init!.signal!
      return new Response(stream, { headers: { "content-type": "application/json" } })
    }, abort.signal, () => {})
    const client = OpenCode.make({ baseUrl: "http://media.invalid", fetch })
    const result = assert.rejects(client.session.message.get({ sessionID: "s", messageID: "m" })).then(() => { settled = true })
    await reading
    if (reason === "abort") abort.abort()
    await cancelling
    await new Promise(resolve => setImmediate(resolve))
    try {
      assert.deepEqual({ settled, locked: stream.locked, listeners: getEventListeners(requestSignal, "abort").length, cancelCalls },
        { settled: true, locked: false, listeners: 0, cancelCalls: 1 })
    } finally { finish(); await result }
    // Let a late rejection surface naturally if the cancellation promise was left unobserved.
    await new Promise(resolve => setImmediate(resolve))
  })
}
