import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import fs from "node:fs"
import test from "node:test"
import { OpenCode, type CredentialEntry } from "@opencode/client"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { createNativeCodexUsage } from "./native-codex"

const quota = (used = 25) => ({ rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18_000 } } })
const credential = (id = "selected", accountID = "native-account"): CredentialEntry => ({
  id, integrationID: "openai", label: "Private account label", active: true,
  value: { type: "oauth", methodID: "chatgpt-browser", access: `secret-access-${id}`, refresh: "secret-refresh",
    expires: Date.now() + 3_600_000, metadata: { accountID } },
})

async function fixture() {
  const state = { integrationID: "openai", selected: { type: "credential", id: "selected", label: "Private", method: "oauth" } as Record<string, unknown>,
    entries: [credential()], status: 200, current: true, calls: [] as string[] }
  const server = createServer((req, res) => {
    state.calls.push(req.url!)
    assert.equal(req.headers.authorization, "Bearer native-daemon-secret")
    res.setHeader("content-type", "application/json")
    if (req.url!.startsWith("/api/provider/")) res.end(JSON.stringify({ location: { directory: "/wsl/project" }, data: {
      id: "model-provider", name: "OpenAI", integrationID: state.integrationID, activation: "auto", package: "openai",
    } }))
    else if (req.url!.startsWith("/api/integration/")) res.end(JSON.stringify({ location: { directory: "/wsl/project" }, data: {
      id: state.integrationID, name: "OpenAI", methods: [], connections: [state.selected],
    } }))
    else if (req.url === "/api/credential") { res.statusCode = state.status; res.end(JSON.stringify({ data: state.entries })) }
    else { res.statusCode = 404; res.end("{}") }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address() as { port: number }
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${address.port}`, headers: { authorization: "Bearer native-daemon-secret" } })
  const connection = { client, assertCurrent: () => { if (!state.current) throw new Error("stale connection secret") } } as ServiceConnection
  return { state, connection, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}
const scope = { instanceId: "instance", sessionId: "session", directory: "/wsl/project", providerId: "model-provider", modelId: "gpt-5" }

test("native location/integration mapping and accountID win without reading host legacy or CLI auth", async () => {
  const f = await fixture()
  const previousFetch = globalThis.fetch
  const previousRead = fs.readFileSync
  let providerCalls = 0
  fs.readFileSync = (() => { throw new Error("host credential read forbidden") }) as typeof fs.readFileSync
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("http://127.0.0.1")) return previousFetch(input, init)
    providerCalls++
    assert.equal(String(input), "https://chatgpt.com/backend-api/wham/usage")
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret-access-selected")
    assert.equal(new Headers(init?.headers).get("ChatGPT-Account-Id"), "native-account")
    assert.equal(init?.redirect, "error")
    assert.ok(init?.signal)
    return Response.json(quota())
  }
  try {
    const usage = createNativeCodexUsage()
    const response = await usage(f.connection, scope, AbortSignal.timeout(2000))
    assert.equal(response?.ok, true)
    assert.equal(response?.windows["5h"].usedPercent, 25)
    assert.equal((await usage(f.connection, scope, AbortSignal.timeout(2000)))?.ok, true)
    assert.equal(providerCalls, 1)
    assert.ok(f.state.calls.some(url => url.startsWith("/api/provider/model-provider?") && new URL(url, "http://fixture").searchParams.get("location[directory]") === "/wsl/project"))
    assert.ok(f.state.calls.some(url => url.startsWith("/api/integration/openai?")))
    assert.equal(JSON.stringify(response).includes("secret"), false)
    assert.equal(JSON.stringify(response).includes("native-account"), false)
  } finally { fs.readFileSync = previousRead; globalThis.fetch = previousFetch; await f.close() }
})

test("only the active selected native ChatGPT OAuth entry may authorize subscription usage", async () => {
  const f = await fixture()
  const previousFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (input, init) => {
    if (String(input).startsWith("http://127.0.0.1")) return previousFetch(input, init)
    calls++; throw new Error("must not use a different account or refresh")
  }
  try {
    const usage = createNativeCodexUsage()
    const invalid = [
      { selected: { type: "credential", id: "key", method: "key", label: "Key" }, entries: [{ ...credential("key"), value: { type: "key", key: "secret-key" } }, { ...credential(), active: false }] },
      { selected: { type: "env", name: "OPENAI_API_KEY" }, entries: [credential()] },
      { selected: { ...f.state.selected, status: { status: "needs_auth", message: "secret" } }, entries: [credential()] },
      { entries: [{ ...credential(), active: false }] },
      { entries: [credential("different")] },
      { entries: [{ ...credential(), integrationID: "other" }] },
      { entries: [{ ...credential(), value: { ...credential().value, type: "oauth", methodID: "other", access: "secret", refresh: "secret", expires: Date.now() + 3600000 } }] },
      { entries: [{ ...credential(), value: { type: "oauth", methodID: "chatgpt-headless", access: "expired", refresh: "secret", expires: 1 } }] },
      { entries: [{ ...credential(), value: { type: "oauth", methodID: "chatgpt-browser", access: "", refresh: "secret", expires: Date.now() + 3600000 } }] },
    ]
    for (const change of invalid) {
      f.state.selected = { type: "credential", id: "selected", method: "oauth", label: "Private" }
      Object.assign(f.state, change)
      const response = await usage(f.connection, scope, AbortSignal.timeout(2000))
      assert.equal(response?.ok, false)
      assert.deepEqual(response?.windows, {})
      assert.equal(JSON.stringify(response).includes("secret"), false)
    }
    f.state.selected = { type: "credential", id: "selected", method: "oauth", label: "Private" }
    f.state.entries = [credential()]; f.state.status = 404
    assert.equal((await usage(f.connection, scope, AbortSignal.timeout(2000)))?.ok, false)
    assert.equal(calls, 0)
  } finally { globalThis.fetch = previousFetch; await f.close() }
})

test("warm snapshots and pending quotas cannot cross selected accounts or native connection generations", async () => {
  const f = await fixture()
  const previousFetch = globalThis.fetch
  let release!: () => void
  let started!: () => void
  let calls = 0
  let gate: Promise<void> | undefined
  let entered: Promise<void> | undefined
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("http://127.0.0.1")) return previousFetch(input, init)
    const used = ++calls
    started?.(); await gate
    return Response.json(quota(used))
  }
  try {
    const usage = createNativeCodexUsage()
    assert.equal((await usage(f.connection, scope, AbortSignal.timeout(2000)))?.windows["5h"].usedPercent, 1)
    f.state.selected.id = "second"; f.state.entries = [credential("second", "second-account")]
    assert.equal((await usage(f.connection, scope, AbortSignal.timeout(2000)))?.windows["5h"].usedPercent, 2)
    // Same credential ID can be replaced with a different account/token.
    f.state.entries = [credential("second", "third-account")]
    gate = new Promise(resolve => { release = resolve }); entered = new Promise(resolve => { started = resolve })
    const pending = usage(f.connection, scope, AbortSignal.timeout(2000))
    await entered
    f.state.entries = [credential("second", "fourth-account")]
    release()
    assert.equal((await pending)?.ok, false)
    gate = undefined
    assert.equal((await usage(f.connection, scope, AbortSignal.timeout(2000)))?.windows["5h"].usedPercent, 4)
    f.state.current = false
    assert.notEqual((await usage(f.connection, scope, AbortSignal.timeout(2000)))?.ok, true)
    f.state.current = true
    const reconnected = { ...f.connection }
    assert.equal((await usage(reconnected, scope, AbortSignal.timeout(2000)))?.windows["5h"].usedPercent, 5)
  } finally { release?.(); globalThis.fetch = previousFetch; await f.close() }
})

test("a missing native credential API exposes only the feature-local upgrade reason", async () => {
  const f = await fixture()
  try {
    const usage = createNativeCodexUsage()
    for (const status of [404, 401, 403, 500]) {
      f.state.status = status
      const response = await usage(f.connection, scope, AbortSignal.timeout(2000))
      assert.equal(response?.ok, false)
      assert.deepEqual(response?.windows, {})
      assert.equal(response?.unavailableReason, status === 404 ? "native-credential-api-unavailable" : undefined)
      assert.equal(JSON.stringify(response).includes("secret"), false)
      assert.equal(JSON.stringify(response).includes("Private"), false)
    }
  } finally { await f.close() }
})

test("quota failures are bounded and sanitized without credential refresh or fallback", async () => {
  const f = await fixture()
  const previousFetch = globalThis.fetch
  const failures = [
    async () => new Response("secret-access-selected", { status: 401 }),
    async () => new Response("secret-refresh", { status: 403 }),
    async () => Response.json({ secret: "secret-refresh" }),
    async () => { throw new Error("Authorization: secret-access-selected") },
    async () => new Response("not json secret"),
    async () => new Response("x".repeat(70_000)),
    async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{\"secret\":")) } })),
    async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("secret timeout")), { once: true })
    }),
  ]
  try {
    for (const fail of failures) {
      let calls = 0
      globalThis.fetch = (input, init) => {
        if (String(input).startsWith("http://127.0.0.1")) return previousFetch(input, init)
        calls++; return fail(input, init)
      }
      const response = await createNativeCodexUsage()(f.connection, scope, AbortSignal.timeout(100))
      assert.equal(response?.ok, false)
      assert.deepEqual(response?.windows, {})
      assert.equal(JSON.stringify(response).includes("secret"), false)
      assert.equal(calls, 1)
    }
  } finally { globalThis.fetch = previousFetch; await f.close() }
})

test("account metadata wins over JWT; headless JWT fallback belongs only to the selected token", async () => {
  const f = await fixture()
  const previousFetch = globalThis.fetch
  const accounts: string[] = []
  const token = (exp = Math.floor(Date.now() / 1000) + 3600) => `header.${Buffer.from(JSON.stringify({
    exp, "https://api.openai.com/auth": { chatgpt_account_id: "jwt-selected-account" },
  })).toString("base64url")}.signature`
  globalThis.fetch = (input, init) => {
    if (String(input).startsWith("http://127.0.0.1")) return previousFetch(input, init)
    accounts.push(new Headers(init?.headers).get("ChatGPT-Account-Id")!)
    return Promise.resolve(Response.json(quota()))
  }
  try {
    const usage = createNativeCodexUsage()
    const entry = credential()
    assert.equal(entry.value.type, "oauth")
    if (entry.value.type !== "oauth") throw new Error("fixture type")
    entry.value.access = token()
    f.state.entries = [entry]
    assert.equal((await usage(f.connection, scope, AbortSignal.timeout(2000)))?.ok, true)
    entry.value.metadata = undefined; entry.value.methodID = "chatgpt-headless"
    assert.equal((await usage(f.connection, scope, AbortSignal.timeout(2000)))?.ok, true)
    assert.deepEqual(accounts, ["native-account", "jwt-selected-account"])
    entry.value.access = token(1)
    assert.equal((await usage(f.connection, scope, AbortSignal.timeout(2000)))?.ok, false)
    entry.value.access = "opaque"; entry.value.metadata = { accountId: "wrong-case-legacy-account" }
    assert.equal((await usage(f.connection, scope, AbortSignal.timeout(2000)))?.ok, false)
    assert.equal(accounts.length, 2)
  } finally { globalThis.fetch = previousFetch; await f.close() }
})

test("pending reads share only the same native connection/instance/session/provider scope", async () => {
  const f = await fixture()
  const previousFetch = globalThis.fetch
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("http://127.0.0.1")) return previousFetch(input, init)
    calls++; entered(); await gate
    return Response.json(quota())
  }
  try {
    const usage = createNativeCodexUsage()
    const first = usage(f.connection, scope, AbortSignal.timeout(2000))
    await started
    const duplicate = usage(f.connection, scope, AbortSignal.timeout(2000))
    // Wait for the second real generated-client selection read, not a timer.
    const deadline = Date.now() + 1000
    while (f.state.calls.filter(url => url === "/api/credential").length < 2 && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    release()
    assert.equal((await first)?.ok, true)
    assert.equal((await duplicate)?.ok, true)
    assert.equal(calls, 1)
    assert.equal((await usage(f.connection, { ...scope, instanceId: "another" }, AbortSignal.timeout(2000)))?.ok, true)
    assert.equal((await usage(f.connection, { ...scope, sessionId: "another" }, AbortSignal.timeout(2000)))?.ok, true)
    assert.equal(calls, 3)
  } finally { release(); globalThis.fetch = previousFetch; await f.close() }
})
