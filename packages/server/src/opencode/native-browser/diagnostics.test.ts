import assert from "node:assert/strict"
import test from "node:test"
import type { DiagnosticContext, DiagnosticEvent, DiagnosticRead } from "../../automation/page/diagnostic-events"
import { PreviewDiagnostics } from "./diagnostics"

/** The host's live contexts after `events`, as a buffer that saw them reports. */
const live = (events: DiagnosticEvent[]): DiagnosticContext[] => {
  const contexts = new Map<number, DiagnosticContext>()
  for (const { method, params } of events) {
    const context = params.context as { id: number; auxData?: { frameId?: string; isDefault?: boolean } } | undefined
    if (method === "Runtime.executionContextCreated" && context)
      contexts.set(context.id, { id: context.id, page: typeof context.auxData?.frameId === "string" && context.auxData.isDefault === true })
    if (method === "Runtime.executionContextDestroyed") contexts.delete(params.executionContextId as number)
  }
  return [...contexts.values()]
}
const read = (events: DiagnosticEvent[], epoch = "buffer:0", next = events.length, lost = { messages: 0, requests: 0 },
  contexts = live(events), lostRequests: string[] = []): DiagnosticRead => ({ epoch, events, next, lost, more: false, contexts, lostRequests })
const event = (method: string, params: Record<string, unknown>): DiagnosticEvent => ({ method, params })
const request = (requestId: string, url: string, extra: Record<string, unknown> = {}) => event("Network.requestWillBeSent", {
  requestId, documentURL: "https://site.test/", timestamp: 10, wallTime: 1_700_000_000, type: "Fetch",
  request: { url, method: "POST", headers: { Cookie: "secret=1", "Content-Type": "application/json" }, postData: "{\"a\":1}", hasPostData: true },
  initiator: { type: "script" }, ...extra,
})

test("console readout: levels, sources, Chromium log entries, exceptions, and only the page's own world", () => {
  const diagnostics = new PreviewDiagnostics()
  diagnostics.ingest(read([
    event("Runtime.executionContextCreated", { context: { id: 1, auxData: { frameId: "main", isDefault: true } } }),
    event("Runtime.executionContextCreated", { context: { id: 2, auxData: { frameId: "main", isDefault: false } } }),
    event("Runtime.consoleAPICalled", { type: "log", executionContextId: 1, timestamp: 5, args: [{ type: "string", value: "hello" }, { type: "number", value: 2 }],
      stackTrace: { callFrames: [{ url: "https://site.test/app.js", lineNumber: 9, columnNumber: 4 }] } }),
    event("Runtime.consoleAPICalled", { type: "warning", executionContextId: 2, timestamp: 6, args: [{ type: "string", value: "isolated world" }] }),
    event("Runtime.consoleAPICalled", { type: "error", executionContextId: 1, timestamp: 7, args: [{ type: "string", value: "extension" }],
      stackTrace: { callFrames: [{ url: "chrome-extension://abc/content.js", lineNumber: 0, columnNumber: 0 }] } }),
    event("Runtime.consoleAPICalled", { type: "debug", executionContextId: 1, timestamp: 8, args: [{ type: "string", value: "verbose" }] }),
    event("Log.entryAdded", { entry: { level: "error", text: "Refused to load the script", timestamp: 9, url: "https://site.test/", lineNumber: 2 } }),
    event("Runtime.exceptionThrown", { timestamp: 10, exceptionDetails: { executionContextId: 1, text: "Uncaught", exception: { description: "TypeError: x is undefined" },
      url: "https://site.test/app.js", lineNumber: 1, columnNumber: 2 } }),
  ]))
  const info = diagnostics.console({})
  assert.deepEqual(info.messages.map(entry => [entry.level, entry.text]), [
    ["info", "hello 2"], ["error", "Refused to load the script"], ["error", "TypeError: x is undefined"],
  ])
  assert.deepEqual(info.messages[0].source, { url: "https://site.test/app.js", line: 10, column: 5 })
  assert.deepEqual(diagnostics.console({ level: "debug" }).messages.map(entry => entry.text).includes("verbose"), true)
  assert.deepEqual(diagnostics.console({ level: "error", limit: 1 }), {
    messages: [info.messages[2]], truncated: true, dropped: 0,
  })
})

test("network readout: wire status, redirects, redacted headers, request bodies and fetched responses", async () => {
  const diagnostics = new PreviewDiagnostics()
  diagnostics.ingest(read([
    // ExtraInfo can precede the renderer's own events.
    event("Network.requestWillBeSentExtraInfo", { requestId: "r1", headers: { authorization: "Bearer token", "x-wire": "1" } }),
    request("r1", "https://site.test/api"),
    event("Network.responseReceived", { requestId: "r1", hasExtraInfo: true, response: { status: 200, mimeType: "application/json", headers: { "Set-Cookie": "id=2" } } }),
    event("Network.responseReceivedExtraInfo", { requestId: "r1", statusCode: 304, headers: { "set-cookie": "id=2", etag: "v1" } }),
    event("Network.loadingFinished", { requestId: "r1", timestamp: 10.25 }),
    request("r2", "https://site.test/old", { type: "Document", request: { url: "https://site.test/old", method: "GET", headers: {} } }),
    request("r2", "https://site.test/new", { type: "Document", timestamp: 11, request: { url: "https://site.test/new", method: "GET", headers: {} },
      redirectResponse: { status: 302, mimeType: "text/html", headers: { location: "/new" } } }),
    event("Network.loadingFailed", { requestId: "r2", timestamp: 12, errorText: "net::ERR_ABORTED" }),
    request("r3", "chrome-extension://abc/x.js"),
    request("r4", "https://site.test/image.png", { type: "Image", request: { url: "https://site.test/image.png", method: "GET", headers: {} } }),
    event("Network.responseReceived", { requestId: "r4", hasExtraInfo: false, response: { status: 200, mimeType: "image/png", headers: {} } }),
    event("Network.loadingFinished", { requestId: "r4", timestamp: 11 }),
  ]))
  const listed = diagnostics.list({})
  assert.deepEqual(listed.requests.map(item => [item.url, item.state, item.statusCode]), [
    ["https://site.test/api", "completed", 304],
    ["https://site.test/old", "completed", 302],
    ["https://site.test/new", "failed", undefined],
    ["https://site.test/image.png", "completed", 200],
  ], "the wire status wins, a redirect is a completed hop, extension requests are omitted")
  assert.equal(listed.requests[0].state === "completed" && listed.requests[0].durationMs, 250)
  assert.deepEqual(diagnostics.list({ urlContains: "/new" }).requests.map(item => item.url), ["https://site.test/new"])
  assert.deepEqual(diagnostics.list({ resourceType: "image" }).requests.map(item => item.url), ["https://site.test/image.png"])

  const fetched: string[] = []
  const got = await diagnostics.get({ id: listed.requests[0].id, includeBody: true, maxBodyChars: 4 }, async nativeID => {
    fetched.push(nativeID)
    return { body: Buffer.from("{\"ok\":true}").toString("base64"), base64Encoded: true }
  })
  assert.deepEqual(fetched, ["r1"])
  assert.deepEqual(got.requestBody, { state: "text", text: "{\"a\"", truncated: true })
  assert.deepEqual(got.responseBody, { state: "text", text: "{\"ok", truncated: true })
  const header = (list: { name: string; value: string }[], name: string) => list.find(item => item.name === name)?.value
  assert.equal(header(got.requestHeaders, "authorization"), "<redacted>")
  assert.equal(header(got.requestHeaders, "cookie"), "<redacted>")
  assert.equal(header(got.requestHeaders, "x-wire"), "1")
  assert.equal(header(got.responseHeaders, "set-cookie"), "<redacted>")
  assert.equal(header(got.responseHeaders, "etag"), "v1")
  const image = await diagnostics.get({ id: listed.requests[3].id, includeResponseBody: true }, async () => assert.fail("binary bodies are never fetched"))
  assert.deepEqual(image.responseBody, { state: "unavailable", reason: "binary" })
  assert.deepEqual((await diagnostics.get({ id: listed.requests[0].id }, async () => assert.fail())).responseBody, { state: "notRequested" })
  const gone = await diagnostics.get({ id: listed.requests[0].id, includeResponseBody: true }, async () => undefined)
  assert.deepEqual(gone.responseBody, { state: "unavailable", reason: "backendUnavailable" })
  await assert.rejects(diagnostics.get({ id: "unknown" }, async () => undefined), /no longer retained/)
  // A body read fenced by a document change is not reported as an unavailable body of the old request.
  await assert.rejects(diagnostics.get({ id: listed.requests[0].id, includeResponseBody: true },
    async () => { throw new Error("Browser page document changed; inspect again") }), /document changed/)
})

test("another epoch restarts the readout from its start, and host evictions count as dropped", () => {
  const diagnostics = new PreviewDiagnostics()
  assert.equal(diagnostics.ingest(read([event("Log.entryAdded", { entry: { level: "info", text: "first", timestamp: 1 } })], "buffer:0", 4)), true)
  assert.equal(diagnostics.cursor, 4)
  // A navigation cleared the host buffer: the stale cursor is dropped and the read is repeated from the start.
  assert.equal(diagnostics.ingest(read([], "buffer:1", 4)), false)
  assert.equal(diagnostics.cursor, 0)
  assert.equal(diagnostics.console({}).messages.length, 0)
  assert.equal(diagnostics.ingest(read([event("Log.entryAdded", { entry: { level: "info", text: "second", timestamp: 2 } })], "buffer:1", 6, { messages: 3, requests: 1 })), true)
  assert.deepEqual(diagnostics.console({}).messages.map(entry => entry.text), ["second"])
  assert.equal(diagnostics.console({}).dropped, 3)
  assert.equal(diagnostics.list({}).dropped, 1, "each readout counts its own losses")
  // The host reports the epoch's losses so far: only their growth is new.
  diagnostics.ingest(read([], "buffer:1", 6, { messages: 4, requests: 1 }))
  assert.deepEqual([diagnostics.console({}).dropped, diagnostics.list({}).dropped], [4, 1])
})

test("at most 500 messages are retained", () => {
  const diagnostics = new PreviewDiagnostics()
  diagnostics.ingest(read(Array.from({ length: 510 }, (_, index) => event("Log.entryAdded", { entry: { level: "info", text: `m${index}`, timestamp: index } }))))
  const all = diagnostics.console({ limit: 1_000 })
  assert.equal(all.messages.length, 500)
  assert.equal(all.messages[0].text, "m10")
  assert.equal(all.dropped, 10)
})

test("only known page contexts log, across a document reopened in place and frames that detach", () => {
  const diagnostics = new PreviewDiagnostics()
  const say = (executionContextId: number, value: string, session?: string): DiagnosticEvent =>
    ({ ...event("Runtime.consoleAPICalled", { type: "log", executionContextId, timestamp: 1, args: [{ type: "string", value }] }), ...(session ? { session } : {}) })
  const contexts: DiagnosticContext[] = [{ id: 1, page: true }, { id: 7, page: false }, { session: "frame", id: 3, page: true }]
  diagnostics.ingest(read([say(1, "page"), say(7, "isolated"), say(9, "unknown"), say(3, "frame", "frame")], "buffer:0", 4, undefined, contexts))
  assert.deepEqual(diagnostics.console({}).messages.map(entry => entry.text), ["page", "frame"])
  // document.open() starts another epoch: the host's live contexts still tell the page's world from an isolated one.
  diagnostics.ingest(read([], "buffer:1", 4, undefined, contexts))
  diagnostics.ingest(read([say(7, "isolated after reopen"), say(1, "page after reopen")], "buffer:1", 6, undefined, contexts))
  assert.deepEqual(diagnostics.console({}).messages.map(entry => entry.text), ["page after reopen"])
  // A detached frame's contexts go with it.
  diagnostics.ingest(read([event("Target.detachedFromTarget", { sessionId: "frame" }), say(3, "late", "frame")], "buffer:1", 8, undefined, contexts.slice(0, 2)))
  assert.deepEqual(diagnostics.console({}).messages.map(entry => entry.text), ["page after reopen"])
  assert.equal((diagnostics as any).contexts.size, 2, "only live contexts are kept")
})

test("a request whose later events the host lost ends as failed instead of staying pending", () => {
  const diagnostics = new PreviewDiagnostics()
  diagnostics.ingest(read([request("slow", "https://site.test/slow")]))
  assert.equal(diagnostics.list({}).requests[0].state, "pending")
  diagnostics.ingest(read([], "buffer:0", 1, { messages: 0, requests: 1 }, [], [":slow"]))
  const [slow] = diagnostics.list({}).requests
  assert.equal(slow.state, "failed")
  assert.equal(diagnostics.list({}).dropped, 1)
})

test("a frame whose detach the host lost ends its requests", () => {
  const diagnostics = new PreviewDiagnostics()
  diagnostics.ingest(read([{ ...request("f1", "https://frame.test/a"), session: "frame" }]))
  diagnostics.ingest(read([], "buffer:0", 1, { messages: 0, requests: 0 }, [], ["frame:*"]))
  assert.equal(diagnostics.list({}).requests[0].state, "failed")
})