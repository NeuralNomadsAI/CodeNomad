import assert from "node:assert/strict"
import test from "node:test"
import { getEventListeners } from "node:events"
import { OpenCode } from "@opencode/client"
import { boundedResponseFetch } from "./bounded-response-fetch"
import { boundedMediaFetch } from "./session-media-fetch"
import { readExplicitForm } from "../server/explicit-form-verification"

function abortAfter(controller: AbortController, depth: number) {
  queueMicrotask(() => depth > 1 ? abortAfter(controller, depth - 1) : controller.abort())
}

test("every headers/admission microtask window owns and cancels the response exactly once", async () => {
  for (const depth of [1, 2, 3, 4, 5, 6]) for (const cleanup of ["held", "rejected"] as const) {
    const abort = new AbortController()
    let cancelled = 0, calls = 0, requestSignal!: AbortSignal
    const body = new ReadableStream<Uint8Array>({ cancel() {
      cancelled++
      return cleanup === "held" ? new Promise(() => {}) : Promise.reject(new Error("synthetic cleanup failure"))
    } })
    const fetch = boundedResponseFetch(async (_input, init) => {
      calls++; requestSignal = init!.signal!; abortAfter(abort, depth)
      return new Response(body)
    }, abort.signal, () => {}, 1)
    await assert.rejects(fetch("http://owned.invalid"))
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual({ calls, cancelled, locked: body.locked, listeners: getEventListeners(requestSignal, "abort").length },
      { calls: 1, cancelled: 1, locked: false, listeners: 0 }, `depth=${depth}, cleanup=${cleanup}`)
    const current = boundedResponseFetch(async () => new Response("x"), new AbortController().signal, () => {}, 1)
    assert.equal(await (await current("http://owned.invalid")).text(), "x")
  }
})

test("pre-dispatch cancellation and late fetch response preserve ownership without replay", async () => {
  const abort = new AbortController()
  let calls = 0, cancelled = 0, finish!: (response: Response) => void, requestSignal!: AbortSignal
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return Promise.reject(new Error("late cleanup")) } })
  const fetch = boundedResponseFetch((_input, init) => {
    calls++; requestSignal = init!.signal!
    return new Promise(resolve => { finish = resolve })
  }, abort.signal, () => {}, 1)
  const pending = fetch("http://owned.invalid"), rejected = assert.rejects(pending)
  abort.abort(); await rejected
  assert.equal(cancelled, 0)
  finish(new Response(body))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual({ calls, cancelled, locked: body.locked, listeners: getEventListeners(requestSignal, "abort").length },
    { calls: 1, cancelled: 1, locked: false, listeners: 0 })
  await assert.rejects(fetch("http://owned.invalid")); assert.equal(calls, 1)
})

for (const consumer of ["media", "Form"] as const) {
  test(`${consumer} official SDK path owns response through every headers/admission window`, async () => {
    for (const depth of [2, 3]) {
      const abort = new AbortController()
      let cancelled = 0, calls = 0, requestSignal!: AbortSignal
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return Promise.reject(new Error("synthetic cleanup")) } })
      const fetch: typeof globalThis.fetch = async (_input, init) => {
        calls++; requestSignal = init!.signal!; abortAfter(abort, depth)
        return new Response(body, { headers: { "content-type": "application/json" } })
      }
      if (consumer === "media") {
        const client = OpenCode.make({ baseUrl: "http://owned.invalid", fetch: boundedMediaFetch(fetch, abort.signal, () => {}) })
        await assert.rejects(client.session.message.get({ sessionID: "s", messageID: "m" }))
      } else {
        const connection = { endpoint: { url: "http://owned.invalid" }, fetch, client: OpenCode.make({ baseUrl: "http://owned.invalid", fetch }),
          profile: async () => "modern" as const, assertCurrent() {}, invalidate() {} }
        await assert.rejects(readExplicitForm({ acquire: async () => connection, current() {}, signal: abort.signal, sessionId: "global", formId: "f", directory: "/owned" }))
      }
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual({ calls, cancelled, locked: body.locked, listeners: getEventListeners(requestSignal, "abort").length },
        { calls: 1, cancelled: 1, locked: false, listeners: 0 }, `depth=${depth}`)
      let positiveCalls = 0
      const healthy: typeof globalThis.fetch = async () => {
        positiveCalls++
        return Response.json({ data: consumer === "media" ? { id: "m" } : { id: "f", sessionID: "global", title: "Known", fields: [{ key: "answer", type: "string", required: true }], state: { status: "pending" } } })
      }
      const signal = new AbortController().signal
      if (consumer === "media") {
        const client = OpenCode.make({ baseUrl: "http://owned.invalid", fetch: boundedMediaFetch(healthy, signal, () => {}) })
        assert.equal((await client.session.message.get({ sessionID: "s", messageID: "m" })).id, "m")
      } else {
        const connection = { endpoint: { url: "http://owned.invalid" }, fetch: healthy, client: OpenCode.make({ baseUrl: "http://owned.invalid", fetch: healthy }),
          profile: async () => "modern" as const, assertCurrent() {}, invalidate() {} }
        assert.equal((await readExplicitForm({ acquire: async () => connection, current() {}, signal, sessionId: "global", formId: "f", directory: "/owned" })).data.state.status, "pending")
      }
      assert.equal(positiveCalls, 1)
    }
  })
}
