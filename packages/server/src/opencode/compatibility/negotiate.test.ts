import assert from "node:assert/strict"
import { test } from "node:test"
import { createRuntimeFetch } from "./transport"
import { rememberRuntime } from "./runtime"
import { legacyContractFixture, modernContractFixture } from "./contract-fixture"
import { UnsupportedOpenCodeError } from "../runtime-support"

test("unknown contracts perform authenticated bounded read negotiation before any mutation", async () => {
  for (const kind of ["unauthorized", "unrecognized", "oversized"] as const) {
    const endpoint = { url: "http://127.0.0.1:4321", auth: { type: "basic" as const, username: "opencode", password: "fixture" } }
    rememberRuntime(endpoint, { version: "2.0.100", pid: 1, discovery: "status" })
    let calls = 0, cancelled = false
    const transport = createRuntimeFetch(endpoint, async (input, init) => {
      calls++
      assert.equal(new URL(String(input)).pathname, "/openapi.json")
      assert.equal(init?.method ?? "GET", "GET")
      assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("opencode:fixture").toString("base64")}`)
      assert.equal(init?.redirect, "error")
      if (kind === "unauthorized") return new Response(null, { status: 401 })
      if (kind === "unrecognized") return Response.json({ paths: {} })
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)) },
        cancel() { cancelled = true },
      }))
    })
    await assert.rejects(transport(`${endpoint.url}/api/session/s`, { method: "PATCH", body: '{"title":"fixture"}' }), /contract|HTTP 401/)
    assert.equal(calls, 1, "negotiation failure must never dispatch a mutation")
    if (kind === "oversized") assert.equal(cancelled, true)
  }
})

test("unknown labels with an obsolete contract or missing environment fail for a concrete API reason", async () => {
  const missingEnvironment = structuredClone(modernContractFixture)
  delete (missingEnvironment.paths as Record<string, unknown>)["/api/session/{sessionID}/environment"]
  for (const [schema, reason] of [[legacyContractFixture, "canonical_api"], [missingEnvironment, "session_environment"]] as const) {
    const endpoint = { url: "http://127.0.0.1:4321" }
    rememberRuntime(endpoint, { version: "custom-build", pid: 1, discovery: "info" })
    let calls = 0
    const transport = createRuntimeFetch(endpoint, async input => {
      calls++
      assert.equal(new URL(String(input)).pathname, "/openapi.json")
      return Response.json(schema)
    })
    await assert.rejects(transport(`${endpoint.url}/api/session/s/prompt`, { method: "POST", body: '{"text":"fixture"}' }),
      (error: unknown) => error instanceof UnsupportedOpenCodeError && error.reason === reason)
    assert.equal(calls, 1, "no speculative prompt or environment mutation")
  }
})

test("shared negotiation has independent subscriber cancellation and never retries a mutation", async () => {
  const endpoint = { url: "http://127.0.0.1:4321" }
  rememberRuntime(endpoint, { version: "2.0.100", pid: 1, discovery: "info" })
  let complete!: (response: Response) => void
  let negotiationSignal: AbortSignal | null | undefined
  const calls: string[] = []
  const transport = createRuntimeFetch(endpoint, async (input, init) => {
    const pathname = new URL(String(input)).pathname
    calls.push(pathname)
    if (pathname === "/openapi.json") {
      negotiationSignal = init?.signal
      return new Promise<Response>(resolve => { complete = resolve })
    }
    assert.equal(pathname, "/api/session/s")
    return new Response(null, { status: 204 })
  })
  const first = new AbortController(), third = new AbortController()
  const a = transport(`${endpoint.url}/api/location`, { signal: first.signal })
  const b = transport(`${endpoint.url}/api/session/s`, { method: "PATCH", body: '{"title":"fixture"}' })
  const c = transport(`${endpoint.url}/api/location`, { signal: third.signal })
  first.abort()
  third.abort()
  await assert.rejects(a, { name: "AbortError" })
  await assert.rejects(c, { name: "AbortError" })
  assert.equal(negotiationSignal?.aborted, false)
  complete(Response.json(modernContractFixture))
  assert.equal((await b).status, 204)
  assert.deepEqual(calls, ["/openapi.json", "/api/session/s"])
})
