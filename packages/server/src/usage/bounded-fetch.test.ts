import assert from "node:assert/strict"
import test from "node:test"
import { fetchBoundedJson, parseQuotaBaseURL } from "./bounded-fetch"
import { ProviderHttpError } from "./shared"

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
