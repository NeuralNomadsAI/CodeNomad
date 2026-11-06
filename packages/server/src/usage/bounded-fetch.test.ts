import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { fetchBoundedJson, parseQuotaBaseURL } from "./bounded-fetch"
import { ProviderHttpError } from "./shared"

test("bounded transport keeps GET callers and supports JSON/form POSTs, forcing redirect refusal", async t => {
  const requests: RequestInit[] = []
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init!)
    return Response.json({ read: true })
  })
  const signal = AbortSignal.timeout(2000)
  const url = "https://simulated.invalid"
  assert.deepEqual(await fetchBoundedJson(url, { Accept: "application/json" }, signal), { read: true })
  await fetchBoundedJson(url, { "Content-Type": "application/json" }, signal, undefined,
    { method: "POST", body: JSON.stringify({ project: "fake-project" }) })
  await fetchBoundedJson(url, { "Content-Type": "application/x-www-form-urlencoded" }, signal, undefined,
    { method: "POST", body: new URLSearchParams({ refresh_token: "fake-refresh" }) })
  await fetchBoundedJson(url, {}, signal, undefined, { redirect: "follow" } as RequestInit)
  assert.equal(requests[0].method, undefined)
  assert.equal(requests[1].method, "POST")
  assert.equal(requests[1].body, '{"project":"fake-project"}')
  assert.equal(new Headers(requests[1].headers).get("content-type"), "application/json")
  assert.equal(String(requests[2].body), "refresh_token=fake-refresh")
  assert.equal(new Headers(requests[2].headers).get("content-type"), "application/x-www-form-urlencoded")
  assert.ok(requests.every(request => request.redirect === "error" && request.signal === signal))
})

test("real fetch refuses a simulated redirect before sending any request to its target", async () => {
  const paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(request.url!)
    response.writeHead(302, { location: "/must-not-receive-fake-token" }).end()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address() as { port: number }
    await assert.rejects(fetchBoundedJson(`http://127.0.0.1:${address.port}/token`,
      { "Content-Type": "application/x-www-form-urlencoded" }, AbortSignal.timeout(2000), undefined,
      { method: "POST", body: new URLSearchParams({ refresh_token: "fake-only" }) }))
    assert.deepEqual(paths, ["/token"])
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

test("bounds UTF-8 bytes, not characters, and aborts during body consumption", async t => {
  let cancelled = 0
  const controller = new AbortController()
  let phase = 0, entered!: () => void
  const consuming = new Promise<void>(resolve => { entered = resolve })
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(stream) {
      if (phase++ === 0) stream.enqueue(new TextEncoder().encode('{"fake":"'))
      else entered()
    },
    cancel() { cancelled++ },
  })))
  const reading = fetchBoundedJson("https://simulated.invalid", {}, controller.signal)
  await consuming
  controller.abort()
  await assert.rejects(reading)
  assert.equal(cancelled, 1)
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify("é".repeat(32_768))))
  await assert.rejects(fetchBoundedJson("https://simulated.invalid", {}, AbortSignal.timeout(2000)), /too large/)
  await assert.rejects(fetchBoundedJson("https://simulated.invalid", {}, AbortSignal.timeout(2000), 131_072), /too large/)
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify("x".repeat(65_534))))
  assert.equal((await fetchBoundedJson("https://simulated.invalid", {}, AbortSignal.timeout(2000)) as string).length, 65_534)
})

test("configured quota destinations admit only credential-free HTTPS domains with optional path prefixes", () => {
  for (const value of ["https://router.example", "https://router.example/api/v1", "https://API.enterprise.example/"]) {
    assert.ok(parseQuotaBaseURL(value), value)
  }
  for (const value of ["http://router.example", "https://u:p@router.example", "https://@router.example", "https://router.example:443",
    "https://router.example:8443/path", "https://router.example/?", "https://router.example/#", "https://router.example/?a=1",
    "https://router.example/#part", "https://127.0.0.1", "https://127.1", "https://2130706433", "https://0x7f000001",
    "https://[::1]", "https://[::ffff:127.0.0.1]", "https://localhost", "https://api.localhost", "https://intranet",
    "https://router.example.", "https://-bad.example", "https://router.example\\@evil.example", " https://router.example",
    "https://router.example/\npath", "https://router.example/\u0000path", null, {}]) {
    assert.equal(parseQuotaBaseURL(value), null, String(value))
  }
})

test("bounded reads refuse redirects, cap bodies, preserve HTTP status and honor cancellation", async t => {
  const controller = new AbortController()
  const calls: RequestInit[] = []
  let response = () => Response.json({ value: 1 })
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { calls.push(init); return response() })
  assert.deepEqual(await fetchBoundedJson("https://quota.example", { Authorization: "Bearer synthetic" }, controller.signal), { value: 1 })
  assert.equal(calls[0].redirect, "error")
  assert.equal(calls[0].signal, controller.signal)
  response = () => new Response("too large")
  await assert.rejects(fetchBoundedJson("https://quota.example", {}, controller.signal, 2), /too large/)
  response = () => new Response("secret-response-body", { status: 403 })
  await assert.rejects(fetchBoundedJson("https://quota.example", {}, controller.signal), error => error instanceof ProviderHttpError && error.status === 403 && !error.message.includes("secret"))
  controller.abort()
  await assert.rejects(fetchBoundedJson("https://quota.example", {}, controller.signal))
  assert.equal(calls.length, 3, "an already aborted read makes no request")
  const aborted = new AbortController()
  response = () => new Response(new ReadableStream({ pull() { aborted.abort() } }))
  await assert.rejects(fetchBoundedJson("https://quota.example", {}, aborted.signal))
})

test("bounded JSON POSTs retain transport fences and the caller's body", async t => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(init.method, "POST")
    assert.equal(init.body, '{"teamId":42}')
    assert.equal(init.redirect, "error")
    assert.equal(new Headers(init.headers).get("Connect-Protocol-Version"), "1")
    return Response.json({ hardLimitPerUser: 250 })
  })
  assert.deepEqual(await fetchBoundedJson("https://quota.example", { "Connect-Protocol-Version": "1" }, undefined, undefined,
    { method: "POST", body: '{"teamId":42}' }), { hardLimitPerUser: 250 })
})
