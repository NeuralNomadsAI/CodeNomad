import assert from "node:assert/strict"
import test, { beforeEach } from "node:test"
import Fastify from "fastify"
import { OpenCode, type CredentialEntry } from "@opencode/client"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { clearProviderUsageCache } from "../../usage/service"
import { registerUsageRoutes, type UsageRouteDeps } from "./usage"
import { googleOAuthClients } from "../../usage/google-credential"

const fakeClients = {
  "gemini-cli": { client_id: "fake-gemini-client-id", client_secret: "fake-gemini-client-secret" },
  antigravity: { client_id: "fake-antigravity-client-id", client_secret: "fake-antigravity-client-secret" },
}
beforeEach(t => {
  assert.ok("mock" in t)
  t.mock.method(googleOAuthClients, "get", (methodID: string) => fakeClients[methodID as keyof typeof fakeClients])
})

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota"
const PUBLIC_CLIENT_SECRET = "fake-gemini-client-secret"
const ANTIGRAVITY_CLIENT_SECRET = "fake-antigravity-client-secret"
const ANTIGRAVITY_QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
const url = "/api/usage/google?instanceId=instance&sessionId=session&modelId=gemini-2.5-pro"
let sequence = 0

function harness(methodID = "gemini-cli") {
  const suffix = ++sequence
  const markers = [`fake-native-access-${suffix}`, `fake-refreshed-access-${suffix}`, `fake-refresh-token-${suffix}`,
    PUBLIC_CLIENT_SECRET, `fake-upstream-error-${suffix}`, `fake-returned-refresh-${suffix}`, `fake-private-project-${suffix}`, ANTIGRAVITY_CLIENT_SECRET]
  const credential: CredentialEntry = { id: `fake-credential-${suffix}`, integrationID: "google", active: true, label: "default",
    value: { type: "oauth", methodID, access: markers[0], refresh: `${markers[2]}|${markers[6]}`,
      expires: Date.now() + 3600_000, metadata: { email: "fake-private-email@example.invalid" } } }
  const state = { credential, refreshCalls: 0, quotaCalls: 0, failRefresh: false, quotaStatus: 200, malformed: false,
    oversized: false, transportFailure: false, unknownWindow: false, gate: undefined as (() => Promise<void>) | undefined,
    native: [] as Array<{ path: string; method: string }>, outbound: [] as Array<{ url: string; init?: RequestInit }> }
  const logs: string[] = []
  const app = Fastify({ logger: { stream: { write(text: string) { logs.push(text) } } } })
  const workspace = {} as NonNullable<ReturnType<UsageRouteDeps["workspaceManager"]["get"]>>
  const client = OpenCode.make({ baseUrl: "http://simulated-opencode.invalid", fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const path = new URL(request.url).pathname
    state.native.push({ path, method: request.method })
    // Intercept EVERY daemon request: all credential and selection mutations fail this assertion.
    assert.equal(request.method, "GET", "quota display must never write an OpenCode connection")
    assert.ok(path === "/api/credential" || path === "/api/session/session", `unapproved native request: ${path}`)
    if (path === "/api/credential") return Response.json({ data: [state.credential] })
    return Response.json({ data: { id: "session", location: { directory: "/fake-owned" } } })
  } })
  const connection = { client, assertCurrent() {} } as ServiceConnection
  const manager: UsageRouteDeps["workspaceManager"] = {
    get: id => id === "instance" ? workspace : undefined,
    getSharedServiceConnection: async () => connection,
    ownsLocation: async (_id, location) => location.directory === "/fake-owned",
    getSessionEnvironment: async () => ({}), getServiceWslDistro: () => undefined,
    getHostPathForServicePath: async () => undefined,
  }
  registerUsageRoutes(app, { workspaceManager: manager })
  const fetchUpstream = async (input: RequestInfo | URL, init?: RequestInit) => {
    state.outbound.push({ url: String(input), init })
    assert.equal(init?.method, "POST")
    assert.equal(init?.redirect, "error")
    assert.ok(init?.signal)
    const echoed = markers.join(" ")
    const antigravity = state.credential.value.type === "oauth" && state.credential.value.methodID === "antigravity"
    if (String(input) === TOKEN_URL) {
      state.refreshCalls++
      const form = new URLSearchParams(String(init?.body))
      assert.equal(form.get("refresh_token"), markers[2])
      assert.equal(form.get("client_secret"), antigravity ? ANTIGRAVITY_CLIENT_SECRET : PUBLIC_CLIENT_SECRET)
      assert.equal(form.get("client_id"), antigravity
        ? "fake-antigravity-client-id"
        : "fake-gemini-client-id")
      assert.equal(String(init?.body).includes(markers[6]), false)
      await state.gate?.()
      return state.failRefresh ? Response.json({ error: "invalid_grant", error_description: echoed }, { status: 400,
        headers: { "x-upstream-private": echoed } })
        : Response.json({ access_token: markers[1], expires_in: 3600, refresh_token: markers[5] })
    }
    assert.equal(String(input), antigravity ? ANTIGRAVITY_QUOTA_URL : QUOTA_URL, "only the declared client's fixed quota endpoint is called")
    state.quotaCalls++
    const access = new Headers(init?.headers).get("authorization")
    assert.ok(access === `Bearer ${markers[0]}` || access === `Bearer ${markers[1]}` || access === "Bearer fake-changed-access")
    assert.equal(init?.body, JSON.stringify({ project: markers[6] }))
    if (state.transportFailure) throw new DOMException(echoed, "TimeoutError")
    if (state.quotaStatus !== 200) return new Response(echoed, { status: state.quotaStatus,
      headers: { location: `https://never-follow.invalid/${markers[0]}`, "x-upstream-private": echoed } })
    if (state.malformed) return new Response(echoed)
    if (state.oversized) return new Response(echoed + "x".repeat(65_537))
    if (antigravity) return Response.json({ groups: [
      { displayName: "Gemini Models", description: echoed, buckets: [
        { window: state.unknownWindow ? "unknown" : "5h", remainingFraction: 0.75, bucketId: echoed, displayName: echoed },
        { window: state.unknownWindow ? undefined : "weekly", remainingFraction: 0.5, resetTime: "2026-11-12T00:00:00Z", bucketId: "gemini-weekly" },
      ] },
      { displayName: echoed, buckets: [{ window: "5h", remainingFraction: 0 }] },
    ], error: echoed, access_token: markers[1] }, { headers: { "x-upstream-private": echoed } })
    return Response.json({ buckets: [{ modelId: "gemini-2.5-pro", tokenType: "REQUESTS", remainingFraction: 0.75,
      resetTime: "2026-11-06T00:00:00Z" }], error: echoed, access_token: markers[1] }, { headers: { "x-upstream-private": echoed } })
  }
  const assertPrivate = (responses: Array<{ body: string; headers: unknown }>) => {
    const sent = [...responses.map(response => response.body + JSON.stringify(response.headers)), ...logs].join("\n")
    for (const marker of [...markers, "fake-changed-access", "fake-private-email@example.invalid", "methodID", "credentialID"]) {
      assert.equal(sent.includes(marker), false, "no credential, upstream prose, or private metadata may leave the server")
    }
    assert.ok(state.native.length > 0)
    assert.ok(state.native.every(request => request.method === "GET"
      && ["/api/credential", "/api/session/session"].includes(request.path)), "no native mutation, even if an assertion was caught")
  }
  clearProviderUsageCache()
  return { app, state, markers, fetchUpstream, assertPrivate }
}

for (const methodID of ["gemini-cli", "antigravity"]) {
test(`${methodID} route reuses valid native access and sends only normalized quota to the browser`, async t => {
  const h = harness(methodID)
  t.mock.method(globalThis, "fetch", h.fetchUpstream)
  try {
    const original = JSON.stringify(h.state.credential)
    const response = await h.app.inject(url)
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["cache-control"], "no-store")
    assert.equal(response.json().configured, true)
    assert.equal(response.json().ok, true)
    assert.equal(response.json().windows[methodID === "antigravity" ? "5h:Gemini" : "requests:gemini-2.5-pro"].usedPercent, 25)
    if (methodID === "antigravity") assert.equal(response.json().windows["weekly:Gemini"].usedPercent, 50)
    assert.equal(h.state.refreshCalls, 0)
    assert.equal(h.state.quotaCalls, 1)
    assert.equal(JSON.stringify(h.state.credential), original)
    h.assertPrivate([response])
  } finally { clearProviderUsageCache(); await h.app.close() }
})

test(`${methodID} route refreshes expired access in memory, coalesces concurrency, fences changed credentials`, async t => {
  const h = harness(methodID)
  t.mock.method(globalThis, "fetch", h.fetchUpstream)
  h.state.credential.value = { ...h.state.credential.value, expires: 1 } as typeof h.state.credential.value
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  h.state.gate = async () => { entered(); await gate }
  try {
    const original = JSON.stringify(h.state.credential)
    const concurrent = Array.from({ length: 8 }, () => h.app.inject(url))
    await started
    release()
    const responses = await Promise.all(concurrent)
    assert.ok(responses.every(response => response.statusCode === 200 && response.json().ok))
    assert.equal(h.state.refreshCalls, 1)
    assert.equal(h.state.quotaCalls, 1)
    assert.equal(h.state.outbound[0].init?.signal, h.state.outbound[1].init?.signal, "refresh and quota share the route's budget")
    assert.equal(JSON.stringify(h.state.credential), original, "no mutation of the daemon credential")
    clearProviderUsageCache()
    responses.push(await h.app.inject(url))
    assert.equal(h.state.refreshCalls, 1, "secret cache survives normalized-quota cache clearing")
    assert.equal(h.state.quotaCalls, 2)
    h.state.credential.value = { ...h.state.credential.value, access: "fake-changed-access", expires: Date.now() + 3600_000 } as typeof h.state.credential.value
    responses.push(await h.app.inject(url))
    assert.equal(h.state.quotaCalls, 3, "credential change bypasses the display cache")
    assert.equal(h.state.refreshCalls, 1, "new valid native access outranks in-memory access")
    assert.equal(new Headers(h.state.outbound.at(-1)?.init?.headers).get("authorization"), "Bearer fake-changed-access")
    h.state.credential.id += "-changed"
    h.state.credential.value = JSON.parse(original).value
    responses.push(await h.app.inject(url))
    assert.equal(h.state.refreshCalls, 2, "a different selected credential ID cannot reuse an earlier connection's access cache")
    assert.equal(h.state.quotaCalls, 4)
    h.assertPrivate(responses)
  } finally { release(); clearProviderUsageCache(); await h.app.close() }
})

test(`${methodID} refresh failure is unknown quota, without a connection error or leaked upstream error`, async t => {
  const h = harness(methodID)
  t.mock.method(globalThis, "fetch", h.fetchUpstream)
  h.state.credential.value = { ...h.state.credential.value, expires: 1 } as typeof h.state.credential.value
  h.state.failRefresh = true
  try {
    const response = await h.app.inject(url)
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().configured, true)
    assert.equal(response.json().ok, false)
    assert.equal(response.json().error, undefined)
    assert.deepEqual(response.json().windows, {})
    assert.equal(h.state.refreshCalls, 1)
    assert.equal(h.state.quotaCalls, 0)
    h.assertPrivate([response])
  } finally { clearProviderUsageCache(); await h.app.close() }
})

test(`${methodID} quota failures redact echoed secrets in bodies, headers and logs`, async t => {
  const h = harness(methodID)
  t.mock.method(globalThis, "fetch", h.fetchUpstream)
  const responses: Awaited<ReturnType<typeof h.app.inject>>[] = []
  try {
    for (const failure of ["401", "403", "429", "302", "invalid-json", "oversized", "timeout"]) {
      clearProviderUsageCache()
      h.state.quotaStatus = Number(failure) || 200
      h.state.malformed = failure === "invalid-json"
      h.state.oversized = failure === "oversized"
      h.state.transportFailure = failure === "timeout"
      const response = await h.app.inject(url)
      responses.push(response)
      assert.equal(response.statusCode, 200)
      assert.equal(response.json().configured, true)
      assert.equal(response.json().ok, false)
      assert.deepEqual(response.json().windows, {})
      assert.equal(response.json().error, undefined)
    }
    assert.equal(h.state.refreshCalls, 0, "401 never triggers speculative refresh or another client")
    assert.equal(h.state.outbound.length, 7, "redirect/error never triggers another endpoint")
    h.assertPrivate(responses)
  } finally { clearProviderUsageCache(); await h.app.close() }
})
}

test("unknown methods remain configured but unread, never refreshing or rotating accounts", async t => {
  const h = harness()
  t.mock.method(globalThis, "fetch", h.fetchUpstream)
  const responses: Awaited<ReturnType<typeof h.app.inject>>[] = []
  try {
    for (const methodID of ["oauth", "unknown"]) {
      h.state.credential.value = { ...h.state.credential.value, methodID, expires: 1 } as typeof h.state.credential.value
      const response = await h.app.inject(url)
      responses.push(response)
      assert.equal(response.statusCode, 200)
      assert.equal(response.json().configured, true)
      assert.equal(response.json().ok, false)
      assert.deepEqual(response.json().windows, {})
    }
    assert.equal(h.state.outbound.length, 0)
    h.assertPrivate(responses)
  } finally { clearProviderUsageCache(); await h.app.close() }
})

test("Antigravity refresh-only login retains its native connection and discards unknown windows", async t => {
  const h = harness("antigravity")
  t.mock.method(globalThis, "fetch", h.fetchUpstream)
  h.state.credential.value = { ...h.state.credential.value, access: "" } as typeof h.state.credential.value
  try {
    const original = JSON.stringify(h.state.credential)
    const response = await h.app.inject(url)
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().ok, true)
    assert.equal(h.state.refreshCalls, 1)
    assert.equal(h.state.quotaCalls, 1)
    assert.equal(JSON.stringify(h.state.credential), original)
    clearProviderUsageCache()
    h.state.unknownWindow = true
    const unknown = await h.app.inject(url)
    assert.equal(unknown.statusCode, 200)
    assert.equal(unknown.json().configured, true)
    assert.equal(unknown.json().ok, false)
    assert.equal(unknown.json().error, undefined)
    assert.deepEqual(unknown.json().windows, {})
    assert.equal(h.state.refreshCalls, 1)
    h.assertPrivate([response, unknown])
  } finally { clearProviderUsageCache(); await h.app.close() }
})

test("changing the native Google method selects the matching client, never another method's access cache", async t => {
  const h = harness()
  t.mock.method(globalThis, "fetch", h.fetchUpstream)
  h.state.credential.value = { ...h.state.credential.value, expires: 1 } as typeof h.state.credential.value
  try {
    const gemini = await h.app.inject(url)
    h.state.credential.value = { ...h.state.credential.value, methodID: "antigravity" } as typeof h.state.credential.value
    const antigravity = await h.app.inject(url)
    assert.equal(gemini.json().ok, true)
    assert.equal(antigravity.json().ok, true)
    assert.equal(h.state.refreshCalls, 2)
    assert.equal(h.state.quotaCalls, 2)
    assert.ok(gemini.json().windows["requests:gemini-2.5-pro"])
    assert.ok(antigravity.json().windows["weekly:Gemini"])
    h.assertPrivate([gemini, antigravity])
  } finally { clearProviderUsageCache(); await h.app.close() }
})
