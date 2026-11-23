import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import Fastify from "fastify"
import { registerSessionNavigationRoutes } from "./session-navigation"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { brokerIdentities, brokerConnection } from "./rpc-broker-test-fixture"

function fixture(pluginsReady: () => Promise<void> = async () => {}) {
  const app = Fastify()
  let owned = true, session: any = { id: "s", projectID: "p", location: { directory: "/repo" } }
  let afterRead = () => {}
  const calls: any[] = []
  const outline = (layout?: object) => ({ status: "outline", entries: [{ id: "m", seq: 1, type: "assistant", tools: 1, reasoning: 0, text: 1,
    toolName: "read", ...layout }], total: 1, cursor: null, checkpoints: [] })
  const methods: Record<string, (signal: AbortSignal, input: any) => unknown> = {
    outline: () => outline(), outlineLayout: () => outline({ layout: "TX" }), outlinePreview: () => ({ status: "previews", entries: [] }),
    window: () => ({ status: "window", messages: [], older: null, newer: null, resume: { kind: "latest" }, latest: true }),
  }
  registerSessionNavigationRoutes(app, { worktreeDeletionFence: new WorktreeDeletionFence(), workspaceManager: {
    ...brokerIdentities(),
    ownsLocation: async () => owned,
    desktopPluginsReady: pluginsReady,
    ...brokerConnection({ session: { get: async () => structuredClone(session) }, rpc: {
       call: async (input: any, options: { signal: AbortSignal }) => {
         calls.push(input); afterRead()
         return { output: await methods[input.method](options.signal, input.input) }
      },
    } } as any),
  } as any })
  return { app, calls, ownership: (value: boolean) => { owned = value }, race: (callback: () => void) => { afterRead = callback },
    change: (value: object) => { session = { ...session, ...value } },
     plugin: (method: string, handler: (signal: AbortSignal, input: any) => unknown) => { methods[method] = handler } }
}
// The native SDK throws a declared RPC error with its body's fields.
const rpcError = (type: string) => Object.assign(new Error(type), { _tag: "RpcError", type, message: type })

test("the outline asks for layouts through the versioned method; only a plugin copy without it gets the legacy one", async () => {
  const f = fixture()
  const send = async () => (await f.app.inject({ method: "POST", url: "/api/workspaces/w/session-history/outline", payload: { sessionID: "s" } })).json()
  try {
    assert.equal((await send()).entries[0].layout, "TX")
    assert.deepEqual(f.calls.map(call => call.method), ["outlineLayout"])
    f.calls.length = 0
    f.plugin("outlineLayout", () => { throw rpcError("rpc.method_not_found") })
    const legacy = await send()
    assert.equal(legacy.status, "outline")
    assert.equal("layout" in legacy.entries[0], false)
    assert.deepEqual(f.calls.map(call => call.method), ["outlineLayout", "outline"])
    assert.deepEqual(f.calls[1].input, f.calls[0].input, "the fallback repeats the exact read")
    f.calls.length = 0
    f.plugin("outlineLayout", () => { throw rpcError("rpc.unavailable") })
    assert.deepEqual(await send(), { status: "blocked", reason: "unavailable" })
    assert.deepEqual(f.calls.map(call => call.method), ["outlineLayout"], "other failures never fall back")
  } finally { await f.app.close() }
})
test("a start-up timeline read waits for the plugin to register before calling it", async () => {
  let release!: () => void
  const registered = new Promise<void>(resolve => { release = resolve })
  const f = fixture(() => registered)
  try {
    const response = f.app.inject({ method: "POST", url: "/api/workspaces/w/session-history/outline", payload: { sessionID: "s" } })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(f.calls.length, 0, "the plugin is not called before it has observed this backend")
    release()
    assert.equal((await response).json().status, "outline")
    assert.equal(f.calls.length, 1)
  } finally { await f.app.close() }
})

test("an opted-in history window defers large tool images like the message list", async () => {
  const f = fixture()
  const uri = `data:image/png;base64,${"A".repeat(64 * 1024)}`
  f.plugin("window", () => ({ status: "window", older: null, newer: null, resume: { kind: "latest" }, latest: true,
    messages: [{ id: "m", type: "assistant", time: { created: 1 }, content: [{ type: "tool", id: "t", name: "read",
      state: { status: "completed", content: [{ type: "file", mime: "image/png", uri }] } }] }] }))
  const read = async (headers: Record<string, string>) => (await f.app.inject({ method: "POST", url: "/api/workspaces/w/session-history/window",
    headers, payload: { sessionID: "s", target: { kind: "latest" } } })).json().messages[0].content[0].state.content[0].uri
  try {
    assert.match(await read({ "x-codenomad-media": "deferred" }), /^\/api\/workspaces\/w\/session-media\/s\/m\/0\/0\/[a-f0-9]{64}$/)
    assert.equal(await read({}), uri)
  } finally { await f.app.close() }
})

test("attachment reads publish only the requested stored bytes while placement and undo remain current", async t => {
  const f = fixture()
  t.after(() => f.app.close())
  const bytes = Buffer.from("attachment fixture")
  const digest = createHash("sha256").update(bytes).digest("hex")
  const url = `/api/workspaces/w/session-attachment/s/m/0/${digest}`
  const send = () => f.app.inject(url)
  const file = { status: "file", data: bytes.toString("base64") }
  f.plugin("sessionAttachment", (_signal, input) => input.confirm ? { status: "current" } : file)
  const response = await send()
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers["content-disposition"], "attachment")
  assert.deepEqual(response.rawPayload, bytes)
  assert.deepEqual(f.calls[0].input, { sessionID: "s", messageID: "m", fileIndex: 0, sha256: digest })
  assert.deepEqual(f.calls[1].input, { ...f.calls[0].input, confirm: true })
  f.plugin("sessionAttachment", (_signal, input) => input.confirm ? { status: "missing" } : file)
  assert.equal((await send()).statusCode, 404, "a committed undo can remove the row without leaving a revert marker")
  f.plugin("sessionAttachment", () => ({ status: "file", data: Buffer.from("different").toString("base64") }))
  assert.equal((await send()).statusCode, 404)
  f.plugin("sessionAttachment", () => file)
  f.race(() => f.change({ revert: { messageID: "m" } }))
  assert.equal((await send()).statusCode, 409)
})

test("closing an attachment download cancels the outstanding plugin request", async t => {
  const f = fixture()
  t.after(() => f.app.close())
  let entered!: (signal: AbortSignal) => void
  const waiting = new Promise<AbortSignal>(resolve => { entered = resolve })
  f.plugin("sessionAttachment", signal => {
    entered(signal)
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  })
  const origin = await f.app.listen({ host: "127.0.0.1", port: 0 })
  const controller = new AbortController()
  const request = fetch(`${origin}/api/workspaces/w/session-attachment/s/m/0/${"a".repeat(64)}`, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
  })
  const result = assert.rejects(request, { name: "AbortError" })
  const signal = await Promise.race([waiting, request.then(() => { throw new Error("Expected plugin request") })])
  const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
  controller.abort()
  await result
  await aborted
})

for (const method of ["outline", "window", "outlinePreview"]) test(`${method} validates ownership and fences location, project, revert and inventory changes`, async () => {
  const f = fixture(), url = `/api/workspaces/w/session-history/${method}`
  const payload = { sessionID: "s", ...(method === "window" ? { target: { kind: "around", messageID: "m" } }
    : method === "outlinePreview" ? { messageIDs: ["m"] } : {}) }
  const send = () => f.app.inject({ method: "POST", url, payload })
  try {
    for (const extra of [{ directory: "/foreign" }, { databasePath: "x" }, { sql: "SELECT 1" }]) {
      assert.equal((await f.app.inject({ method: "POST", url, payload: { ...payload, ...extra } })).statusCode, 400)
    }
    f.ownership(false)
    assert.equal((await send()).statusCode, 403)
    assert.equal(f.calls.length, 0)
    f.ownership(true)
    assert.equal((await send()).json().status, method === "outlinePreview" ? "previews" : method)
    assert.deepEqual(f.calls[0].location, { directory: "/repo" })
    for (const change of [{ location: { directory: "/other" } }, { projectID: "clone" }, { revert: { messageID: "m" } }]) {
      f.race(() => f.change(change))
      assert.deepEqual((await send()).json(), { status: "blocked", reason: "conflict" })
    }
    f.race(() => f.ownership(false))
    assert.deepEqual((await send()).json(), { status: "blocked", reason: "conflict" })
  } finally { await f.app.close() }
})
