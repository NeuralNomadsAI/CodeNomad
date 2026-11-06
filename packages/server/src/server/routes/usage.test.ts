import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { OpenCode } from "@opencode/client"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { registerUsageRoutes, type UsageRouteDeps } from "./usage"
import { clearProviderUsageCache, getProviderUsage, resolveUsageProvider } from "../../usage/service"
import type { ProviderReadContext } from "../../usage/types"
import { createOpenCodeFreeExhaustion } from "../../usage/opencode-free-exhaustion"
import { createOpenCodeFreeUsage } from "../../usage/opencode-free-usage"
import { readUsageCredentials } from "../../usage/native-credentials"

function harness() {
  const expires = Date.now() + 3600000
  const state = { nativeCalls: [] as string[], quotaCalls: 0, directory: "/wsl/repo", switched: false, oldEndpoint: false, fail: false,
    stale: false, evicted: false, statsMissing: false, freeSteps: 42, statsQuery: undefined as URLSearchParams | undefined, statsGate: undefined as (() => Promise<void>) | undefined,
    daemonEnvironment: { HOME: "/home/dev" } as Record<string, string>, hostFiles: new Map<string, { path: string }>(),
    integrations: {} as Record<string, string>, settings: {} as Record<string, unknown>, providerMissing: false,
    providerDirectory: undefined as string | undefined, providerQuery: undefined as URLSearchParams | undefined }
  const logs: string[] = []
  const app = Fastify({ logger: { stream: { write: (text: string) => { logs.push(text) } } } })
  const workspace = {} as NonNullable<ReturnType<UsageRouteDeps["workspaceManager"]["get"]>>
  const client = OpenCode.make({ baseUrl: "http://isolated-native.invalid", fetch: async (input) => {
    const url = new URL(String(input)); state.nativeCalls.push(url.pathname)
    if (state.fail) throw new Error("secret-refresh Authorization secret-token")
    if (url.pathname === "/api/experimental/session/stats") {
      state.statsQuery = url.searchParams
      await state.statsGate?.()
      if (state.statsMissing) return Response.json({}, { status: 404 })
      const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      return Response.json({ data: { range: { from: Number(url.searchParams.get("from")), to: Number(url.searchParams.get("to")) },
        sessions: 1, subagents: 0, prompts: 1, steps: 248, tokens, cost: 0, tools: { mode: "none" }, activeDays: 1, streak: 1, activity: [], models: [
        { model: { providerID: "opencode", id: "big-pickle" }, steps: state.freeSteps, tokens, cost: 0 },
        { model: { providerID: "opencode", id: "example-free" }, steps: 8, tokens, cost: 0 },
        { model: { providerID: "opencode", id: "paid" }, steps: 99, tokens, cost: 0 },
        { model: { providerID: "other", id: "example-free" }, steps: 99, tokens, cost: 0 },
      ] } })
    }
    if (url.pathname === "/api/session/missing") return Response.json({ _tag: "SessionNotFoundError", sessionID: "missing" }, { status: 404 })
    if (url.pathname.startsWith("/api/session/")) return Response.json({ data: { id: "session", location: { directory: state.directory } } })
    if (url.pathname.startsWith("/api/provider/")) {
      state.providerQuery = url.searchParams
      if (state.providerMissing) return Response.json({}, { status: 404 })
      const id = decodeURIComponent(url.pathname.split("/")[3])
      return Response.json({ location: { directory: state.providerDirectory ?? state.directory }, data: {
        id, name: id, activation: "auto", package: id, ...(state.integrations[id] ? { integrationID: state.integrations[id] } : {}),
        settings: state.settings,
      } })
    }
    if (url.pathname === "/api/integration/openai") return Response.json({ location: { directory: state.directory }, data: {
      id: "openai", name: "OpenAI", methods: [], connections: [{ type: "credential", method: "oauth", id: state.switched ? "other" : "selected", label: "Secret account" }],
    } })
    if (url.pathname === "/api/credential") return Response.json({ data: [{ id: "selected", integrationID: "openai", active: true, label: "Secret account",
      value: { type: "oauth", methodID: "chatgpt-headless", access: "secret-token", refresh: "secret-refresh", expires,
        metadata: { accountID: "secret-account" } },
    }, { id: "key", integrationID: "deepinfra", active: true, label: "Key", value: { type: "key", key: "secret-deepinfra" } },
    { id: "go", integrationID: "opencode-go", active: true, label: "Go", value: { type: "key", key: "secret-go-key" } },
    { id: "console", integrationID: "opencode", active: true, label: "Console", value: { type: "oauth", methodID: "device",
      access: "secret-console", refresh: "secret-console-refresh", expires, metadata: { orgID: "org_fixture", server: "https://opencode.ai/console" } } }] },
    { status: state.oldEndpoint ? 404 : 200 })
    return Response.json({}, { status: 404 })
  } })
  const connection = { client, assertCurrent: () => { if (state.stale) throw new Error("stale connection") } } as ServiceConnection
  const manager: UsageRouteDeps["workspaceManager"] = {
    get: id => id === "instance" && !state.evicted ? workspace : undefined,
    getSharedServiceConnection: async () => connection,
    ownsLocation: async (_id, location) => location.directory === "/wsl/repo",
    getSessionEnvironment: async () => ({ ...state.daemonEnvironment }),
    getServiceWslDistro: () => "Ubuntu",
    getHostPathForServicePath: async (_id, servicePath) => state.hostFiles.get(servicePath)?.path,
  }
  const exhaustion = createOpenCodeFreeExhaustion()
  const freeUsage = createOpenCodeFreeUsage(exhaustion)
  registerUsageRoutes(app, { workspaceManager: manager, freeUsage })
  app.addHook("onClose", async () => { exhaustion.dispose(); freeUsage.dispose() })
  return { app, state, logs, exhaustion, connection }
}
const url = "/api/usage/openai?instanceId=instance&sessionId=session&modelId=gpt-5"
const freeUrl = "/api/usage/opencode?instanceId=instance&sessionId=session&modelId=big-pickle"

test("free estimate reads only service-wide daily stats after session ownership, without credentials", async () => {
  const { app, state } = harness()
  try {
    state.directory = "/foreign"
    assert.equal((await app.inject(freeUrl)).statusCode, 403)
    assert.equal(state.statsQuery, undefined)
    state.directory = "/wsl/repo"
    const response = await app.inject(freeUrl)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().estimated, true)
    assert.equal(response.json().providerName, "OpenCode Console")
    assert.equal(response.json().windows.daily.usedPercent, 25)
    assert.equal(response.json().windows.daily.valueLabel, "50 / 200")
    const query = state.statsQuery!
    assert.equal(query.get("timezone"), "UTC")
    assert.equal(query.get("tools"), "none")
    assert.equal(Number(query.get("from")) % 86400000, 0)
    assert.ok(Number(query.get("to")) - Number(query.get("from")) < 86400000)
    assert.equal(query.has("project"), false)
    assert.ok(state.nativeCalls.every(path => path.startsWith("/api/session/") || path === "/api/experimental/session/stats"))
  } finally { await app.close() }
})

test("free estimates fence session movement and reconnect during the stats read", async () => {
  for (const change of ["move", "reconnect"]) {
    const { app, state } = harness()
    let started!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    state.statsGate = async () => { started(); await gate }
    try {
      const response = app.inject(freeUrl)
      await entered
      if (change === "move") state.directory = "/foreign"
      else state.stale = true
      release()
      assert.equal((await response).statusCode, change === "move" ? 403 : 503)
    } finally { release(); await app.close() }
  }
})

test("missing stats or invalid step counts report unavailable rather than unused quota", async () => {
  const { app, state } = harness()
  try {
    state.statsMissing = true
    const missing = await app.inject(freeUrl)
    assert.equal(missing.statusCode, 200)
    assert.equal(missing.json().ok, false)
    assert.equal(missing.json().providerName, "OpenCode Console")
    assert.equal(missing.json().freeEstimate.requests, null)
    assert.deepEqual(missing.json().windows, {})
    state.statsMissing = false; state.freeSteps = -1
    const invalid = await app.inject(freeUrl)
    assert.equal(invalid.statusCode, 200)
    assert.equal(invalid.json().ok, false)
    assert.equal(invalid.json().freeEstimate.requests, null)
  } finally { await app.close() }
})

test("free exhaustion survives stats failure and appears on other free models without credentials", async () => {
  const { app, state, connection, exhaustion } = harness()
  try {
    const now = Date.now()
    exhaustion.observe(connection, { type: "session.step.started", created: now - 1,
      data: { sessionID: "another-session", assistantMessageID: "m", model: { providerID: "opencode", id: "big-pickle" } } })
    exhaustion.observe(connection, { type: "session.step.failed", created: now,
      data: { sessionID: "another-session", assistantMessageID: "m", error: { type: "provider.quota" } } })
    state.statsMissing = true
    const response = await app.inject(freeUrl.replace("big-pickle", "example-free"))
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().ok, true)
    assert.deepEqual(response.json().freeEstimate, { requests: null, reference: 200, exhausted: true })
    assert.equal(response.json().windows.daily.usedPercent, 100)
    assert.equal(response.json().windows.daily.valueLabel, undefined)
    assert.equal(state.nativeCalls.includes("/api/credential"), false)
  } finally { await app.close() }
})

test("exact UTC midnight has zero elapsed usage without querying a future time", async t => {
  t.mock.method(Date, "now", () => Date.UTC(2026, 10, 3))
  const { app, state } = harness()
  try {
    const response = await app.inject(freeUrl)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().windows.daily.usedPercent, 0)
    assert.equal(state.statsQuery, undefined)
  } finally { await app.close() }
})

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

test("a missing native credential endpoint is unavailability, not a host fallback", async () => {
  const { app, state } = harness()
  state.oldEndpoint = true
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error("No legacy fallback permitted") }
  try {
    const response = await app.inject({ url })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().supported, true)
    assert.equal(response.json().ok, false)
    assert.equal(response.json().unavailableReason, undefined)
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

test("usage readers receive only native effective settings from the authorized session Location", async () => {
  const { app, state, logs } = harness()
  const provider = resolveUsageProvider("deepinfra")!
  const original = provider.fetchQuota
  const contexts: Array<ProviderReadContext | undefined> = []
  provider.fetchQuota = async (auth, context) => {
    assert.equal((auth.deepinfra as { key: string }).key, "secret-deepinfra")
    contexts.push(context)
    return { providerId: provider.id, providerName: provider.name, ok: false, configured: true, usage: null, fetchedAt: 1 }
  }
  const read = () => app.inject(url.replace("/usage/openai", "/usage/deepinfra"))
  clearProviderUsageCache()
  try {
    state.directory = "/foreign"
    assert.equal((await read()).statusCode, 403)
    assert.equal(Boolean(state.providerQuery), false)
    state.directory = "/wsl/repo"
    state.settings = { baseURL: "https://quota.example/v1", apiKey: "secret-effective-key", headers: { Authorization: "secret-header" } }
    const resolved = await read()
    assert.equal(resolved.statusCode, 200)
    assert.deepEqual(contexts[0]?.settings, { baseURL: "https://quota.example/v1", apiKey: "secret-effective-key" })
    assert.equal(contexts[0]?.settingsStatus, "available")
    assert.ok(contexts[0]?.signal instanceof AbortSignal)
    assert.equal(contexts[0]?.signal?.aborted, false)
    assert.equal(state.providerQuery?.get("location[directory]"), "/wsl/repo")
    state.settings.apiKey = "{env:SYNTHETIC_NOT_RESOLVED}"
    const unresolved = await read()
    assert.deepEqual(contexts[1]?.settings, { baseURL: "https://quota.example/v1" })
    assert.equal(contexts[1]?.settingsStatus, "unresolved")
    state.settings = { baseURL: "{file:./endpoint}", apiKey: "{file:./key}" }
    await read()
    assert.deepEqual(contexts[2]?.settings, { baseURL: "{file:./endpoint}" })
    state.providerMissing = true
    const missing = await read()
    assert.equal(missing.statusCode, 200)
    assert.equal(contexts[3]?.settingsStatus, "unavailable")
    assert.equal(contexts[3]?.settings, undefined)
    state.providerMissing = false; state.providerDirectory = "/foreign"
    clearProviderUsageCache()
    await read()
    assert.equal(contexts[4]?.settingsStatus, "unavailable")
    assert.equal([resolved.body, unresolved.body, missing.body, ...logs].join("").includes("secret-"), false)
  } finally { provider.fetchQuota = original; clearProviderUsageCache(); await app.close() }
})

test("OpenCode Go reads the session provider's own native login, without env cookies", async () => {
  const { app, state, logs } = harness()
  const previous = { workspace: process.env.OPENCODE_GO_WORKSPACE_ID, cookie: process.env.OPENCODE_GO_AUTH_COOKIE }
  delete process.env.OPENCODE_GO_WORKSPACE_ID; delete process.env.OPENCODE_GO_AUTH_COOKIE
  const requests: Array<{ url: string; authorization: string | null; org: string | null }> = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    requests.push({ url: String(input), authorization: headers.get("authorization"), org: headers.get("x-org-id") })
    if (String(input).endsWith("/console/api/go/status")) return Response.json({ access: { meters: {
      fiveHour: { usedMicroCents: "42", limitMicroCents: "100", resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    } } })
    if (String(input).endsWith("/console/api/billing/status")) return Response.json({ availableMicroCents: "150000000" })
    return Response.json({ usage: { rolling: { status: "ok", percent: 42, resetsAt: new Date(Date.now() + 3_600_000).toISOString() } } })
  }
  const goUrl = url.replace("/usage/openai", "/usage/opencode-go")
  try {
    const key = await app.inject({ url: goUrl })
    assert.equal(key.json().ok, true)
    assert.equal(key.json().windows["5h"].usedPercent, 42)
    assert.equal(key.json().windows.credits_balance, undefined, "API keys cannot invent a Console wallet")
    state.integrations["opencode-go"] = "opencode"
    const consoleUsage = await app.inject({ url: goUrl })
    assert.equal(consoleUsage.json().ok, true)
    assert.equal(consoleUsage.json().windows["5h"].usedPercent, 42)
    assert.equal(consoleUsage.json().windows.credits_balance.balanceUSD.remaining, 1.5)
    assert.deepEqual(requests, [
      { url: "https://opencode.ai/zen/go/v1/usage", authorization: "Bearer secret-go-key", org: null },
      { url: "https://opencode.ai/console/api/go/status", authorization: "Bearer secret-console", org: "org_fixture" },
      { url: "https://opencode.ai/console/api/billing/status", authorization: "Bearer secret-console", org: "org_fixture" },
    ])
    assert.equal([key.body, ...logs].join("").includes("secret-"), false)
  } finally {
    globalThis.fetch = previousFetch
    await app.close()
    if (previous.workspace !== undefined) process.env.OPENCODE_GO_WORKSPACE_ID = previous.workspace
    if (previous.cookie !== undefined) process.env.OPENCODE_GO_AUTH_COOKIE = previous.cookie
  }
})

test("Go exposes only its allowlisted expired-key reason and fixed action", async t => {
  const { app, logs } = harness()
  let status = 401, code = "api_key_expired"
  t.mock.method(globalThis, "fetch", async () => Response.json({ code, message: "secret-body" }, { status }))
  try {
    for (const [httpStatus, errorCode] of [[401, "api_key_expired"], [401, "invalid_api_key"], [403, "api_key_expired"]] as const) {
      status = httpStatus; code = errorCode
      clearProviderUsageCache()
      const response = await app.inject(url.replace("/usage/openai", "/usage/opencode-go"))
      assert.equal(response.statusCode, 200)
      const data = response.json()
      assert.equal(data.configured, true)
      assert.equal(data.ok, false)
      assert.deepEqual(data.windows, {})
      const expired = httpStatus === 401 && errorCode === "api_key_expired"
      assert.equal(data.unavailableReason, expired ? "opencode-go-key-expired" : undefined)
      assert.equal(data.unavailableAction, expired ? "opencode-go-new-key" : undefined)
      assert.equal([response.body, ...logs].join("").includes("secret-"), false)
    }
  } finally { clearProviderUsageCache(); await app.close() }
})

test("paid opencode sessions read Console counters, never the Go cookie endpoint", async () => {
  const { app, state, logs } = harness()
  const previous = { workspace: process.env.OPENCODE_GO_WORKSPACE_ID, cookie: process.env.OPENCODE_GO_AUTH_COOKIE }
  delete process.env.OPENCODE_GO_WORKSPACE_ID; delete process.env.OPENCODE_GO_AUTH_COOKIE
  const requests: Array<{ url: string; authorization: string | null; cookie: string | null }> = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    requests.push({ url: String(input), authorization: headers.get("authorization"), cookie: headers.get("cookie") })
    return Response.json(String(input).includes("summary") ? {
      totalRequests: "12", totalInputTokens: "0", totalOutputTokens: "0", totalCacheReadTokens: "0",
      totalCacheWrite5mTokens: "0", totalCacheWrite1hTokens: "0", totalCostMicroCents: "0", services: [],
    } : { items: [], pageInfo: { page: 1, pageSize: 50, total: 0, pageCount: 0 } })
  }
  state.integrations.opencode = "opencode"
  const consoleUrl = url.replace("/usage/openai", "/usage/opencode")
  clearProviderUsageCache()
  try {
    process.env.OPENCODE_GO_WORKSPACE_ID = "wrk_fixture"; process.env.OPENCODE_GO_AUTH_COOKIE = "fixture-cookie"
    const response = await app.inject({ url: consoleUrl })
    assert.equal(response.json().ok, true)
    assert.equal(response.json().providerId, "opencode-console")
    assert.equal(state.providerQuery, undefined, "fixed Console reads need no model-provider settings")
    assert.equal(response.json().providerName, "OpenCode Console")
    assert.deepEqual(response.json().console.requests, { "24h": 12, "7d": 12, "30d": 12 })
    assert.deepEqual(response.json().console.budgets, { status: "unavailable", items: [] })
    assert.equal(requests.length, 4)
    assert.ok(requests.every(r => r.url.startsWith("https://opencode.ai/console/api/usage/") &&
      r.authorization === "Bearer secret-console" && r.cookie === null))
    assert.equal([response.body, ...logs].join("").includes("secret-"), false)
  } finally {
    globalThis.fetch = previousFetch
    clearProviderUsageCache()
    await app.close()
    if (previous.workspace === undefined) delete process.env.OPENCODE_GO_WORKSPACE_ID
    else process.env.OPENCODE_GO_WORKSPACE_ID = previous.workspace
    if (previous.cookie === undefined) delete process.env.OPENCODE_GO_AUTH_COOKIE
    else process.env.OPENCODE_GO_AUTH_COOKIE = previous.cookie
  }
})

for (const boundary of ["unchanged", "move", "reconnect", "evict"] as const) {
  test(`Console route timeout stays typed and revalidates publication (${boundary})`, async t => {
    const { app, state, logs, connection } = harness()
    const timeout = globalThis.setTimeout
    t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
      timeout(callback, delay === 15_000 ? 20 : delay, ...args))
    const cleanup = new AbortController()
    let transportSignal: AbortSignal | undefined, entered!: () => void, calls = 0
    const started = new Promise<void>(resolve => { entered = resolve })
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      calls++
      transportSignal = init!.signal!
      if (boundary === "move") state.directory = "/foreign"
      if (boundary === "reconnect") state.stale = true
      if (boundary === "evict") state.evicted = true
      entered()
      const signal = AbortSignal.any([transportSignal, cleanup.signal])
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("secret-upstream", "AbortError")), { once: true })
      })
    })
    clearProviderUsageCache()
    let other: ReturnType<typeof getProviderUsage> | undefined
    try {
      const response = app.inject(url.replace("/usage/openai", "/usage/opencode"))
      await started
      const auth = await readUsageCredentials(connection, new AbortController().signal)
      other = getProviderUsage("opencode", { auth })
      const result = await response
      assert.equal(result.statusCode, boundary === "unchanged" ? 200 : boundary === "reconnect" ? 503 : 403)
      if (boundary === "unchanged") {
        assert.equal(result.json().unavailableReason, "opencode-console-network-error")
        assert.equal(result.json().providerName, "OpenCode Console")
        assert.equal(result.json().ok, false)
        assert.deepEqual(result.json().windows, {})
        assert.equal(result.json().console, undefined)
      } else assert.equal(result.json().unavailableReason, undefined)
      assert.equal(state.nativeCalls.filter(path => path === "/api/session/session").length, 2)
      assert.equal(transportSignal?.aborted, false, "route timeout cannot cancel another caller's shared transport")
      assert.equal(calls, 1)
      assert.equal([result.body, ...logs].join("").includes("secret-"), false)
    } finally {
      cleanup.abort()
      await other
      clearProviderUsageCache()
      await app.close()
    }
  })
}

for (const status of [401, 403]) {
  test(`Console HTTP ${status} reason reaches the route without upstream secrets or Go fallback`, async t => {
    const { app, logs } = harness()
    let calls = 0
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("secret-upstream", { status }) })
    clearProviderUsageCache()
    try {
      const response = await app.inject(url.replace("/usage/openai", "/usage/opencode"))
      assert.equal(response.statusCode, 200)
      assert.equal(response.json().ok, false)
      assert.equal(response.json().unavailableReason, `opencode-console-${status === 401 ? "invalid-credential" : "access-denied"}`)
      assert.deepEqual(response.json().windows, {})
      assert.equal(response.json().console, undefined)
      assert.equal(calls, 1)
      assert.equal([response.body, ...logs].join("").includes("secret-"), false)
    } finally { clearProviderUsageCache(); await app.close() }
  })
}

// opencode-claude's `claude-code` and OpenCode's own Claude Agent both run Claude Code.
for (const providerId of ["claude-code", "claude-agent"]) {
  test(`${providerId} sessions read Claude Code's login on the daemon host, never returning it`, async () => {
    const { app, state, logs } = harness()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-usage-route-claude-"))
    const file = path.join(directory, "credentials.json")
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "secret-distro-login", expiresAt: Date.now() + 3_600_000 } }))
    const authorizations: string[] = []
    const previousFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://api.anthropic.com/api/oauth/usage")
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "")
      return Response.json({ limits: [{ kind: "session", percent: 7 }] })
    }
    const claudeUrl = url.replace("/usage/openai", `/usage/${providerId}`)
    clearProviderUsageCache()
    try {
      // Without a Claude Code login on the daemon host, no other credential stands in.
      const unconfigured = await app.inject({ url: claudeUrl })
      assert.equal(unconfigured.json().supported, true)
      assert.equal(unconfigured.json().configured, false)
      assert.deepEqual(authorizations, [])
      state.hostFiles.set("/home/dev/.claude/.credentials.json", { path: file })
      const response = await app.inject({ url: claudeUrl })
      assert.equal(response.json().requestedProviderId, providerId)
      assert.equal(response.json().providerId, "claude-code")
      assert.equal(response.json().windows["5h"].usedPercent, 7)
      // A profile token outranks the stored login and fences the cached snapshot.
      state.daemonEnvironment.CLAUDE_CODE_OAUTH_TOKEN = "secret-profile-token"
      assert.equal((await app.inject({ url: claudeUrl })).json().ok, true)
      assert.deepEqual(authorizations, ["Bearer secret-distro-login", "Bearer secret-profile-token"])
      assert.equal([unconfigured.body, response.body, ...logs].join("").includes("secret-"), false)
    } finally {
      globalThis.fetch = previousFetch
      clearProviderUsageCache()
      await app.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
}
