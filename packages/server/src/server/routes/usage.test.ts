import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { OpenCode } from "@opencode/client"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { registerUsageRoutes, type UsageRouteDeps } from "./usage"

function harness() {
  const expires = Date.now() + 3600000
  const state = { nativeCalls: [] as string[], quotaCalls: 0, directory: "/wsl/repo", switched: false, oldEndpoint: false, fail: false }
  const logs: string[] = []
  const app = Fastify({ logger: { stream: { write: (text: string) => { logs.push(text) } } } })
  const workspace = {} as NonNullable<ReturnType<UsageRouteDeps["workspaceManager"]["get"]>>
  const client = OpenCode.make({ baseUrl: "http://isolated-native.invalid", fetch: async (input) => {
    const url = new URL(String(input)); state.nativeCalls.push(url.pathname)
    if (state.fail) throw new Error("secret-refresh Authorization secret-token")
    if (url.pathname === "/api/session/missing") return Response.json({ _tag: "SessionNotFoundError", sessionID: "missing" }, { status: 404 })
    if (url.pathname.startsWith("/api/session/")) return Response.json({ data: { id: "session", location: { directory: state.directory } } })
    if (url.pathname.startsWith("/api/provider/")) return Response.json({ location: { directory: state.directory }, data: {
      id: "openai", name: "OpenAI", activation: "auto", package: "openai",
    } })
    if (url.pathname === "/api/integration/openai") return Response.json({ location: { directory: state.directory }, data: {
      id: "openai", name: "OpenAI", methods: [], connections: [{ type: "credential", method: "oauth", id: state.switched ? "other" : "selected", label: "Secret account" }],
    } })
    if (url.pathname === "/api/credential") return Response.json({ data: [{ id: "selected", integrationID: "openai", active: true, label: "Secret account",
      value: { type: "oauth", methodID: "chatgpt-headless", access: "secret-token", refresh: "secret-refresh", expires,
        metadata: { accountID: "secret-account" } },
    }, { id: "key", integrationID: "deepinfra", active: true, label: "Key", value: { type: "key", key: "secret-deepinfra" } }] },
    { status: state.oldEndpoint ? 404 : 200 })
    return Response.json({}, { status: 404 })
  } })
  const connection = { client, assertCurrent: () => {} } as ServiceConnection
  const manager: UsageRouteDeps["workspaceManager"] = {
    get: id => id === "instance" ? workspace : undefined,
    getSharedServiceConnection: async () => connection,
    ownsLocation: async (_id, location) => location.directory === "/wsl/repo",
  }
  registerUsageRoutes(app, { workspaceManager: manager })
  return { app, state, logs }
}
const url = "/api/usage/openai?instanceId=instance&sessionId=session&modelId=gpt-5"

test("rejects missing/unknown workspace and missing/foreign session before credential access", async () => {
  const { app, state } = harness()
  try {
    assert.equal((await app.inject({ url: "/api/usage/openai" })).statusCode, 400)
    assert.equal((await app.inject({ url: url.replace("instanceId=instance", "instanceId=unknown") })).statusCode, 404)
    assert.equal(state.nativeCalls.length, 0)
    assert.equal((await app.inject({ url: url.replace("sessionId=session", "sessionId=missing") })).statusCode, 404)
    state.directory = "/foreign"
    assert.equal((await app.inject({ url })).statusCode, 403)
    assert.ok(state.nativeCalls.every(path => path.startsWith("/api/session/")))
  } finally { await app.close() }
})

test("owned native quota response is normalized; credentials and upstream errors never reach API or logs", async () => {
  const { app, state, logs } = harness()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    state.quotaCalls++
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-token")
    return Response.json({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } })
  }
  try {
    const response = await app.inject({ url })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["cache-control"], "no-store")
    assert.equal(response.json().ok, true, JSON.stringify({ body: response.json(), calls: state.nativeCalls }))
    assert.equal(response.json().windows["5h"].usedPercent, 25)
    assert.equal((await app.inject({ url })).json().ok, true)
    assert.equal(state.quotaCalls, 1)
    state.switched = true
    const switched = await app.inject({ url })
    assert.equal(switched.json().ok, false)
    assert.deepEqual(switched.json().windows, {})
    state.fail = true
    const failed = await app.inject({ url })
    assert.equal(failed.statusCode, 503)
    assert.equal([response.body, switched.body, failed.body, ...logs].join("").includes("secret-"), false)
  } finally { globalThis.fetch = previousFetch; await app.close() }
})

test("older native credential endpoint is feature-local unavailability, not a host fallback", async () => {
  const { app, state } = harness()
  state.oldEndpoint = true
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error("No legacy fallback permitted") }
  try {
    const response = await app.inject({ url })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().supported, true)
    assert.equal(response.json().ok, false)
    assert.equal(response.json().unavailableReason, "native-credential-api-unavailable")
    assert.deepEqual(response.json().windows, {})
  } finally { globalThis.fetch = previousFetch; await app.close() }
})

test("session movement during quota fetch fences publication", async () => {
  const { app, state } = harness()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { state.directory = "/foreign"; return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } }) }
  try {
    const response = await app.inject({ url })
    assert.equal(response.statusCode, 403)
    assert.equal(response.body.includes("windows"), false)
  } finally { globalThis.fetch = previousFetch; await app.close() }
})

test("owned unknown provider retains a typed unsupported result without a quota request", async () => {
  const { app, state } = harness()
  try {
    const response = await app.inject({ url: url.replace("/usage/openai", "/usage/unknown-provider") })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().providerId, null)
    assert.equal(response.json().supported, false)
    assert.deepEqual(response.json().windows, {})
    assert.equal(state.nativeCalls.includes("/api/credential"), false)
  } finally { await app.close() }
})

test("other providers use the daemon's selected native credential, never returning it", async () => {
  const { app, logs } = harness()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.deepinfra.com/v1/me?checklist=true")
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-deepinfra")
    return Response.json({ checklist: { stripe_balance: -4 } })
  }
  try {
    const response = await app.inject({ url: url.replace("/usage/openai", "/usage/deepinfra") })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().ok, true)
    assert.equal(response.json().windows.credits_balance.valueLabel, "$4.00")
    assert.equal([response.body, ...logs].join("").includes("secret-"), false)
  } finally { globalThis.fetch = previousFetch; await app.close() }
})
