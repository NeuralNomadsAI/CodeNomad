import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib"
import { OpenCode } from "@opencode/client"
import { readExplicitForm } from "./explicit-form-verification"
import { FORM_VERIFICATION_LIMIT as limit } from "../opencode/form-verification-policy"
import type { ServiceConnection } from "../workspaces/opencode-service"

const directory = "/é %25 日本", fields = [{ key: "answer", type: "string", required: true }]
const form = (state: unknown = { status: "pending" }, extra = {}) => ({ data: { id: "frm_q", sessionID: "ses_s", title: "Known", fields, state, ...extra } })
const session = { data: { id: "ses_s", location: { directory } } }
function reader(response: () => Response, options: { global?: boolean; signal?: AbortSignal; current?: () => void; native?: typeof fetch } = {}) {
  const calls: { path: string; headers: Headers }[] = []
  const fetch: typeof globalThis.fetch = options.native ?? (async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname
    calls.push({ path, headers: new Headers(init?.headers) })
    return path.includes("/form/") ? response() : Response.json(session)
  })
  const connection: ServiceConnection = { endpoint: { url: "http://127.0.0.1" }, fetch, client: OpenCode.make({ baseUrl: "http://127.0.0.1", fetch }),
    profile: async () => "modern", assertCurrent: options.current ?? (() => {}), invalidate() {} }
  return { calls, read: () => readExplicitForm({ acquire: async () => connection, signal: options.signal ?? new AbortController().signal,
    current: options.current ?? (() => {}), sessionId: options.global ? "global" : "ses_s", formId: "frm_q", directory }) }
}
test("session 2+1 and global 1; complete native fields/codecs, extensions ignored, answers never leave reader", async () => {
  const nativeFields = [
    ...fields, { type: "number", key: "n", minimum: "-Infinity", maximum: "Infinity", default: "NaN", when: [{ key: "a", op: "neq", value: true }] },
    { type: "integer", key: "i", minimum: -0.5, default: "Infinity" }, { type: "boolean", key: "b", default: false },
    { type: "multiselect", key: "m", options: [{ value: "x", label: "X", description: "desc" }], minItems: 0, maxItems: 2, default: ["x"] },
    { type: "external", key: "e", url: "https://example.invalid" },
    { type: "string", key: "s", format: "email", options: [], custom: true, hidden: true, pattern: ".*", minLength: 0, maxLength: 3 },
  ]
  for (const global of [false, true]) for (const status of ["pending", "answered", "cancelled"]) {
    const state = status === "answered" ? { status, answer: { text: "ANSWER-SENTINEL", numeric: "NaN", bool: false, multi: ["x"] } } : { status }
    const f = reader(() => Response.json(form(state, { sessionID: global ? "global" : "ses_s", fields: nativeFields, future: "ignored" })), { global })
    const result = await f.read()
    assert.equal(result.data.state.status, status)
    assert(!JSON.stringify(result).includes("ANSWER-SENTINEL"))
    assert.equal(f.calls.length, global ? 1 : 3)
    assert.equal(f.calls.filter(call => call.path.includes("/form/")).length, 1)
    if (global) assert.equal(f.calls[0].headers.get("x-opencode-directory"), encodeURIComponent(directory))
    assert(!f.calls.some(call => /permission|list|rpc|location/.test(call.path)))
  }
})
for (const [name, value] of [
  ["missing success shape", { data: { unexpected: true } }],
  ["wrong Form", form(undefined, { id: "frm_other" })], ["wrong session", form(undefined, { sessionID: "ses_other" })],
  ["unknown state", form({ status: "future" })], ["missing answer", form({ status: "answered" })],
  ["bad answer", form({ status: "answered", answer: { value: {} } })],
  ["bad cancel message", form({ status: "cancelled", message: 12 })],
  ["unknown field", form(undefined, { fields: [{ key: "x", type: "future" }] })],
  ["bad option", form(undefined, { fields: [{ key: "x", type: "multiselect", options: [{ value: "x" }] }] })],
  ["bad condition", form(undefined, { fields: [{ key: "x", type: "string", when: [{ key: "a", op: "gt", value: 1 }] }] })],
  ["negative count", form(undefined, { fields: [{ key: "x", type: "string", minLength: -1 }] })],
  ["fractional count", form(undefined, { fields: [{ key: "x", type: "multiselect", options: [], maxItems: 0.5 }] })],
  ["foreign envelope", { ...form(), location: { directory: "/foreign" } }],
] as const) test(`WIRE rejects ${name} before usable SDK data`, async () => {
  const f = reader(() => Response.json(value))
  await assert.rejects(f.read())
  assert.equal(f.calls.length, 2)
})
test("SDK counterexamples, all error statuses, wrong media type and nonfinite JSON remain indeterminate", async () => {
  for (const status of [400, 401, 404, 500]) for (const body of [
    { _tag: "PermissionNotFoundError", requestID: "frm_q" }, { _tag: "FormNotFoundError", id: "frm_q", message: "PRIVATE-SENTINEL" },
    { message: "generic" }, { _tag: "SessionNotFoundError", sessionID: "ses_s", message: "missing" },
  ]) await assert.rejects(reader(() => Response.json(body, { status })).read())
  for (const raw of ["{", JSON.stringify(form()).replace('"pending"', '1e400')]) await assert.rejects(reader(() => new Response(raw, { headers: { "content-type": "application/json" } })).read())
  await assert.rejects(reader(() => new Response(JSON.stringify(form()), { headers: { "content-type": "text/plain" } })).read())
})
test("each success/error HTTP response has exact 4MiB decompressed ceiling, regardless of Content-Length", async () => {
  const base = JSON.stringify(form()), padded = (bytes: number) => base + " ".repeat(bytes - Buffer.byteLength(base))
  await reader(() => new Response(padded(limit), { headers: { "content-type": "application/json", "content-length": "1" } })).read()
  await assert.rejects(reader(() => new Response(padded(limit), { status: 404, headers: { "content-type": "application/json" } })).read(), /Invalid Form verification response/)
  for (const status of [200, 404]) {
    const f = reader(() => new Response(padded(limit + 1), { status, headers: { "content-type": "application/json", "content-length": "1" } }))
    await assert.rejects(f.read(), /too large/)
  }
})
test("real HTTP gzip/deflate/br are counted after native fetch decompression", async t => {
  let length = limit, status = 200
  const compress = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync }
  let encoding: keyof typeof compress = "gzip"
  const app = createServer((_request, response) => {
    const body = JSON.stringify(form(undefined, { sessionID: "global" }))
    const bytes = compress[encoding](Buffer.from(body + " ".repeat(length - Buffer.byteLength(body))))
    response.writeHead(status, { "content-type": "application/json", "content-encoding": encoding, "content-length": bytes.length })
    response.end(bytes)
  })
  await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>(resolve => app.close(() => resolve())))
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`
  for (encoding of ["gzip", "deflate", "br"] as const) {
    const native: typeof fetch = (input, init) => globalThis.fetch(new URL(new URL(String(input)).pathname, origin), init)
    for (status of [200, 404]) {
      length = limit
      const exact = reader(() => { throw new Error("unused") }, { global: true, native }).read()
      if (status === 200) await exact
      else await assert.rejects(exact, /Invalid Form verification response/)
      length = limit + 1; await assert.rejects(reader(() => { throw new Error("unused") }, { global: true, native }).read(), /too large/)
    }
  }
})
test("overflow cancels once and releases lock without waiting for a held rejecting cleanup", async () => {
  let cancels = 0, rejectCleanup!: (error: Error) => void
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(limit + 1)) },
    cancel() { cancels++; return new Promise<void>((_resolve, reject) => { rejectCleanup = reject }) } })
  const f = reader(() => new Response(stream, { headers: { "content-type": "application/json" } }))
  await assert.rejects(f.read(), /too large/)
  assert.equal(cancels, 1); assert.equal(stream.locked, false)
  rejectCleanup(new Error("Owned cleanup rejection"))
})
