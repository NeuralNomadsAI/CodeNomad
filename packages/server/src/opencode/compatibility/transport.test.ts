import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { test } from "node:test"
import { OpenCode } from "@opencode/client"
import type { Endpoint } from "@opencode/client/service"
import { rememberRuntime } from "./runtime"
import { createRuntimeFetch } from "./transport"
import { modernContractFixture } from "./contract-fixture"

test("the pinned info client follows the discovered route across legacy, modern and info runtimes", async () => {
  for (const [version, discovery, route] of [
    ["2.0.0", "health", "/api/health"],
    ["2.0.4", "status", "/api/status"],
    ["2.0.7", "info", "/api/info"],
    ["2.0.11", "info", "/api/info"],
    ["future-release", "info", "/api/info"],
  ] as const) {
    const endpoint: Endpoint = { url: "http://127.0.0.1:4321", auth: { type: "basic", username: "opencode", password: "fixture" } }
    rememberRuntime(endpoint, { version, pid: 123, discovery })
    const seen: string[] = []
    const fetch = createRuntimeFetch(endpoint, async (input, init) => {
      const path = new URL(String(input)).pathname
      seen.push(path)
      assert.equal(init?.redirect, "error")
      assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("opencode:fixture").toString("base64")}`)
      if (path === "/openapi.json") return Response.json(modernContractFixture)
      assert.equal(path, route)
      return Response.json(discovery === "health" ? { healthy: true, version, pid: 123 }
        : { version, pid: 123, urls: [endpoint.url], ...(discovery === "info" ? { paths: { tmp: "/fixture/tmp" } } : {}) })
    })
    const client = OpenCode.make({ baseUrl: endpoint.url, fetch })
    assert.deepEqual(await client.server.info(), { version, pid: 123, urls: [endpoint.url],
      ...(discovery === "info" ? { paths: { tmp: "/fixture/tmp" } } : {}) })
    assert.deepEqual(seen, discovery === "info" ? ["/openapi.json", route] : [route])
  }
})

test("info translation is GET-only and does not probe alternate routes on failure", async () => {
  const endpoint: Endpoint = { url: "http://127.0.0.1:4321" }
  rememberRuntime(endpoint, { version: "2.0.7", pid: 123, discovery: "info" })
  const seen: string[] = []
  const fetch = createRuntimeFetch(endpoint, async (input, init) => {
    const path = new URL(String(input)).pathname
    seen.push(`${init?.method ?? "GET"} ${path}`)
    return path === "/openapi.json" ? Response.json(modernContractFixture) : new Response(null, { status: 404 })
  })
  const client = OpenCode.make({ baseUrl: endpoint.url, fetch })
  await assert.rejects(client.server.info())
  await fetch(`${endpoint.url}/api/info`, { method: "POST" })
  await fetch(`${endpoint.url}/api/status`, { method: "POST" })
  assert.deepEqual(seen, ["GET /openapi.json", "GET /api/info", "POST /api/info", "POST /api/status"])
})

test("the pinned client uses the earlier wire contract and retains admission/list timestamps", async () => {
  const seen: Array<{ method: string; path: string; body: unknown }> = []
  const item = { id: "inbox-fixture", sessionID: "s", type: "user", payload: { text: "fixture" }, delivery: "queue", timeCreated: 123 }
  const server = createServer(async (req, res) => {
    let raw = ""
    for await (const data of req) raw += data
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("opencode:fixture").toString("base64")}`)
    seen.push({ method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : undefined })
    res.setHeader("content-type", "application/json")
    if (req.url === "/api/session/s/prompt") return res.end(JSON.stringify({ data: item }))
    if (req.url === "/api/session/s/inbox") return res.end(JSON.stringify({ data: [item] }))
    if (req.url === "/api/session/s/fork") return res.end(JSON.stringify({ data: { id: "fork" } }))
    if (req.url?.startsWith("/api/session/s/interrupt")) return res.end("{}")
    res.writeHead(204).end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const endpoint: Endpoint = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, auth: { type: "basic", username: "opencode", password: "fixture" } }
  rememberRuntime(endpoint, { version: "2.0.3", pid: 1, discovery: "health" })
  const client = OpenCode.make({ baseUrl: endpoint.url, fetch: createRuntimeFetch(endpoint) })
  try {
    assert.equal((await client.session.prompt({ sessionID: "s", text: "fixture" })).time.created, 123)
    assert.equal((await client.session.inbox.list({ sessionID: "s" }))[0].time.created, 123)
    await client.permission.reply({ sessionID: "s", requestID: "p", decision: "once" })
    await client.session.command({ sessionID: "s", name: "test", text: "args", delivery: "queue" })
    await client.session.fork({ sessionID: "s", before: "m" })
    await client.session.interrupt({ sessionID: "s", resume: true })
    await client.session.inbox.update({ sessionID: "s", inboxID: "i", delivery: "steer" })
    await client.session.form.cancel({ sessionID: "s", formID: "f" })
    await client.session.instructions.entry.remove({ sessionID: "s", key: "voice" })
    assert.deepEqual(seen.slice(2), [
      { method: "POST", path: "/api/session/s/permission/p/reply", body: { reply: "once" } },
      { method: "POST", path: "/api/session/s/command", body: { command: "test", text: "args", delivery: "queue" } },
      { method: "POST", path: "/api/session/s/fork", body: { boundary: { type: "before", messageID: "m" } } },
      { method: "POST", path: "/api/session/s/interrupt?continue=true", body: undefined },
      { method: "POST", path: "/api/session/s/inbox/i/steer", body: undefined },
      { method: "POST", path: "/api/session/s/form/f/cancel", body: undefined },
      { method: "DELETE", path: "/api/session/s/instructions/entries/voice", body: undefined },
    ])
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test("errors never retry a mutation, unsupported fields are rejected, and abort/auth are preserved", async () => {
  const endpoint: Endpoint = { url: "http://127.0.0.1:4321" }
  rememberRuntime(endpoint, { version: "2.0.3", pid: 2, discovery: "health" })
  let calls = 0
  for (const status of [400, 401, 404, 500]) {
    const client = OpenCode.make({ baseUrl: endpoint.url, fetch: createRuntimeFetch(endpoint, async () => { calls++; return new Response(null, { status }) }) })
    await assert.rejects(client.session.update({ sessionID: "s", title: "title" }))
  }
  assert.equal(calls, 4)
  const client = OpenCode.make({ baseUrl: endpoint.url, fetch: createRuntimeFetch(endpoint, async () => { calls++; return new Response(null, { status: 204 }) }) })
  await assert.rejects(client.session.update({ sessionID: "s", title: "title", permissions: [] }), (error: Error) => {
    assert.match(String((error as Error & { cause?: unknown }).cause), /title-only/)
    return true
  })
  assert.equal(calls, 4)
  const controller = new AbortController()
  controller.abort()
  const transport = createRuntimeFetch(endpoint, async (_url, init) => {
    assert.equal(init?.redirect, "error")
    init?.signal?.throwIfAborted()
    throw new Error("unexpected live request")
  })
  await assert.rejects(transport(new Request(`${endpoint.url}/api/session/s/wait`, { method: "POST", signal: controller.signal })), { name: "AbortError" })
  await assert.rejects(transport("http://127.0.0.1:4322/api/session"), /origin mismatch/)
})
