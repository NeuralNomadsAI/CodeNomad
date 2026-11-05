import assert from "node:assert/strict"
import test, { beforeEach } from "node:test"
import { googleCredential, createGoogleTokenReader } from "./google-credential"
import { googleOAuthClients } from "./google-credential"

const fakeClients = {
  "gemini-cli": { client_id: "fake-gemini-client-id", client_secret: "fake-gemini-client-secret" },
  antigravity: { client_id: "fake-antigravity-client-id", client_secret: "fake-antigravity-client-secret" },
}
beforeEach(t => {
  assert.ok("mock" in t)
  t.mock.method(googleOAuthClients, "get", (methodID: string) => fakeClients[methodID as keyof typeof fakeClients])
})

const login = (changes: Record<string, unknown> = {}) => ({ google: { type: "oauth", methodID: "gemini-cli",
  access: "fake-native-access", refresh: "fake-refresh|fake-project|fake-managed", expires: 1, ...changes } })
const signal = () => AbortSignal.timeout(2000)

test("Google parser selects only the declared client and separates refresh/project context", () => {
  for (const methodID of ["oauth", "unknown", undefined]) assert.equal(googleCredential(login({ methodID })), null)
  for (const entry of [undefined, "fake-key", { type: "key", methodID: "gemini-cli", key: "fake" }]) {
    assert.equal(googleCredential({ google: entry }), null)
  }
  const parsed = googleCredential(login())!
  assert.equal(parsed.refresh, "fake-refresh")
  assert.equal(parsed.project, "fake-managed")
  assert.match(parsed.identity, /^[0-9a-f]{64}$/)
  assert.equal(googleCredential(login({ refresh: "fake-refresh|fake-project" }))!.project, "fake-project")
  assert.equal(googleCredential(login({ refresh: "fake-refresh||fake-managed" }))!.project, "fake-managed")
  assert.equal(googleCredential(login({ refresh: "fake-refresh" }))!.project, null)
  const antigravity = googleCredential(login({ methodID: "antigravity", access: "" }))!
  assert.equal(antigravity.methodID, "antigravity")
  assert.equal(antigravity.access, null)
  assert.equal(antigravity.refresh, "fake-refresh")
  assert.equal(antigravity.project, "fake-managed")
  assert.equal(googleCredential(login({ methodID: "antigravity", refresh: "fake-refresh|fake-project" }))!.project, "fake-project")
  for (const change of [{ methodID: "oauth" }, { refresh: "other|fake-project|fake-managed" }, { access: "other" },
    { expires: 2 }, { refresh: "fake-refresh|other|fake-managed" }, { metadata: { accountID: "other" } }, { credentialID: "other" }]) {
    assert.notEqual(googleCredential(login(change))?.identity, parsed.identity)
  }
  assert.equal(googleCredential(login({ access: "x".repeat(16_385) })), null)
  assert.equal(googleCredential(login({ refresh: "x".repeat(16_385) })), null)
})

test("Antigravity refresh-only and expired credentials use their own client and isolated in-memory cache", async t => {
  let now = 10_000
  t.mock.method(Date, "now", () => now)
  const clients: string[] = [], refreshes: string[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://oauth2.googleapis.com/token")
    assert.equal(init?.redirect, "error")
    const form = new URLSearchParams(String(init?.body))
    clients.push(form.get("client_id")!)
    refreshes.push(form.get("refresh_token")!)
    assert.equal(form.get("client_secret"), clients.at(-1) === "fake-antigravity-client-id"
      ? "fake-antigravity-client-secret" : "fake-gemini-client-secret")
    return Response.json({ access_token: `fake-antigravity-refreshed-${clients.length}`, expires_in: 10,
      refresh_token: "fake-returned-refresh-never-retained" })
  })
  const read = createGoogleTokenReader()
  const auth = login({ methodID: "antigravity", access: "", expires: now + 100_000 })
  const original = JSON.stringify(auth)
  const credential = googleCredential(auth)!
  assert.equal(await read(credential, signal()), "fake-antigravity-refreshed-1", "empty access refreshes despite a future expiry")
  assert.equal(await read(credential, signal()), "fake-antigravity-refreshed-1")
  now += 10_000
  assert.equal(await read(credential, signal()), "fake-antigravity-refreshed-2")
  assert.equal(await read(googleCredential(login({ methodID: "antigravity", access: "fake-expired-antigravity" }))!, signal()), "fake-antigravity-refreshed-3")
  assert.equal(await read(googleCredential(login({ access: "" }))!, signal()), "fake-antigravity-refreshed-4", "same refresh/context with another method cannot reuse access")
  assert.deepEqual(clients, [...Array(3).fill("fake-antigravity-client-id"),
    "fake-gemini-client-id"])
  assert.deepEqual(refreshes, Array(4).fill("fake-refresh"))
  assert.equal(JSON.stringify(auth), original)
})

test("uses native access until its actual expiry, then refreshes once and caches only access", async t => {
  let now = 10_000
  t.mock.method(Date, "now", () => now)
  let calls = 0
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++
    assert.equal(String(input), "https://oauth2.googleapis.com/token")
    assert.equal(init?.method, "POST")
    assert.equal(init?.redirect, "error")
    assert.equal(new Headers(init?.headers).get("content-type"), "application/x-www-form-urlencoded")
    assert.equal(init?.signal?.aborted, false)
    const form = new URLSearchParams(String(init?.body))
    assert.equal(form.get("grant_type"), "refresh_token")
    assert.equal(form.get("refresh_token"), "fake-refresh")
    assert.equal(form.get("client_id"), "fake-gemini-client-id")
    assert.equal(form.get("client_secret"), "fake-gemini-client-secret")
    assert.equal(String(init?.body).includes("fake-project"), false)
    return Response.json({ access_token: `fake-refreshed-${calls}`, expires_in: 10, refresh_token: "fake-returned-refresh-NEVER-USE" })
  })
  const read = createGoogleTokenReader()
  const auth = login({ expires: now + 1000, client_id: "fake-foreign-client", client_secret: "fake-foreign-client-secret",
    metadata: { token_endpoint: "https://never-use-credential-endpoint.invalid/token" } })
  Object.freeze(auth.google)
  const before = JSON.stringify(auth)
  const credential = googleCredential(auth)!
  assert.equal(await read(credential, signal()), "fake-native-access", "no two-minute early refresh")
  assert.equal(calls, 0)
  now += 1000
  assert.equal(await read(credential, signal()), "fake-refreshed-1")
  assert.equal(await read(credential, signal()), "fake-refreshed-1")
  // Even a cached token yields to a valid native access token.
  now = 10_001
  assert.equal(await read(credential, signal()), "fake-native-access")
  now = 21_000
  assert.equal(await read(credential, signal()), "fake-refreshed-2")
  assert.equal(calls, 2)
  assert.equal(JSON.stringify(auth), before)
})

test("coalesces refreshes per full identity; changed credentials cannot reuse the secret cache", async t => {
  let calls = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(globalThis, "fetch", async () => {
    const count = ++calls
    await gate
    return Response.json({ access_token: `fake-refreshed-${count}`, expires_in: 3600 })
  })
  const read = createGoogleTokenReader()
  const credential = googleCredential(login())!
  const reads = Array.from({ length: 8 }, () => read(credential, signal()))
  const other = read(googleCredential(login({ access: "fake-changed-access" }))!, signal())
  assert.equal(calls, 2)
  release()
  assert.deepEqual(await Promise.all(reads), Array(8).fill("fake-refreshed-1"))
  assert.equal(await other, "fake-refreshed-2")
})

test("bounds cached identities and evicts expired access tokens", async t => {
  let now = 1000, calls = 0
  t.mock.method(Date, "now", () => now)
  t.mock.method(globalThis, "fetch", async () => Response.json({ access_token: `fake-cache-${++calls}`, expires_in: 10 }))
  const read = createGoogleTokenReader()
  const first = googleCredential(login({ expires: 0 }))!
  await read(first, signal())
  for (let i = 0; i < 32; i++) await read(googleCredential(login({ access: `fake-cache-native-${i}`, expires: 0 }))!, signal())
  assert.equal(calls, 33)
  await read(first, signal())
  assert.equal(calls, 34, "oldest identity evicted at 32 cached tokens")
  now += 10_000
  await read(first, signal())
  assert.equal(calls, 35, "expired token evicted")
})

test("bounds simultaneous refresh identities without breaking same-identity coalescing", async t => {
  let calls = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    await gate
    return Response.json({ access_token: "fake-bounded", expires_in: 3600 })
  })
  const read = createGoogleTokenReader()
  const credentials = Array.from({ length: 33 }, (_, index) => googleCredential(login({ access: `fake-pending-${index}` }))!)
  const pending = credentials.slice(0, 32).map(credential => read(credential, signal()))
  try {
    pending.push(read(credentials[0], signal()))
    await assert.rejects(read(credentials[32], signal()))
    assert.equal(calls, 32)
  } finally { release(); await Promise.all(pending) }
})

test("refresh failures, redirects and malformed responses stay retryable and never change credentials", async t => {
  let response: () => Response = () => new Response("fake-refresh invalid_grant", { status: 400 })
  const requests: string[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(String(input))
    assert.equal(init?.redirect, "error")
    return response()
  })
  const read = createGoogleTokenReader()
  const credential = googleCredential(login())!
  for (const next of [
    () => new Response("fake-refresh invalid_grant", { status: 400 }),
    () => new Response(null, { status: 302, headers: { location: "https://must-not-follow.invalid" } }),
    () => new Response("not-json-fake-refresh"),
    () => new Response("x".repeat(65_537)),
    () => Response.json({ access_token: "fake-new", expires_in: 0 }),
    () => Response.json({ access_token: "fake-new", expires_in: "3600" }),
    () => Response.json({ expires_in: 3600 }),
  ]) {
    response = next
    await assert.rejects(read(credential, signal()))
  }
  response = () => Response.json({ access_token: "fake-recovered", expires_in: 3600 })
  assert.equal(await read(credential, signal()), "fake-recovered")
  assert.ok(requests.every(url => url === "https://oauth2.googleapis.com/token"))
  const calls = requests.length
  await assert.rejects(read(googleCredential(login({ access: "fake-no-refresh", refresh: "" }))!, signal()))
  await assert.rejects(read(credential, AbortSignal.abort()))
  assert.equal(requests.length, calls)
})
