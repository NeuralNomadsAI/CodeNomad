import assert from "node:assert/strict"
import { test } from "node:test"
import { OpenCode } from "@opencode/client"
import { rememberRuntime } from "./runtime"
import { createRuntimeFetch } from "./transport"
import { modernContractFixture } from "./contract-fixture"

test("current and future supported releases preserve info, authentication and bounded negotiation", async () => {
  for (const version of ["2.0.11", "2.0.100"]) {
    const endpoint = { url: "http://127.0.0.1:4321", auth: { type: "basic" as const, username: "opencode", password: "fixture" } }
    rememberRuntime(endpoint, { version, pid: 123, discovery: "info" })
    const seen: string[] = []
    const fetch = createRuntimeFetch(endpoint, async (input, init) => {
      const path = new URL(String(input)).pathname
      seen.push(path)
      assert.equal(init?.redirect, "error")
      assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("opencode:fixture").toString("base64")}`)
      return Response.json(path === "/openapi.json" ? modernContractFixture : { version, pid: 123, urls: [endpoint.url], paths: { tmp: "/native/tmp" } })
    })
    const client = OpenCode.make({ baseUrl: endpoint.url, fetch })
    assert.equal((await client.server.info()).paths.tmp, "/native/tmp")
    assert.deepEqual(seen, version === "2.0.11" ? ["/api/info"] : ["/openapi.json", "/api/info"])
  }
})

test("retired runtime contracts never dispatch even through the direct transport", async () => {
  for (const version of ["2.0.0", "2.0.3", "2.0.4", "2.0.10", "0.0.0-beta-19271", "3.0.0"]) {
    const endpoint = { url: "http://127.0.0.1:4321" }
    rememberRuntime(endpoint, { version, pid: 1, discovery: "health" })
    const fetch = createRuntimeFetch(endpoint, async () => { assert.fail("unsupported runtime must not receive calls") })
    await assert.rejects(fetch(`${endpoint.url}/api/session/s`, { method: "PATCH", body: '{"title":"fixture"}' }), /opencode_update_required/)
  }
})

test("canonical mutations and inbox timestamps are forwarded unchanged", async () => {
  const endpoint = { url: "http://127.0.0.1:4321" }
  rememberRuntime(endpoint, { version: "2.0.11", pid: 1, discovery: "info" })
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const client = OpenCode.make({ baseUrl: endpoint.url, fetch: createRuntimeFetch(endpoint, async (input, init) => {
    const request = new Request(input, init)
    calls.push({ path: new URL(request.url).pathname, method: request.method, body: request.body ? await request.json() : undefined })
    if (request.url.endsWith("/prompt")) return Response.json({ data: { time: { created: 123 } } })
    return new Response(null, { status: 204 })
  }) })
  assert.equal((await client.session.prompt({ sessionID: "s", text: "fixture" })).time.created, 123)
  await client.permission.reply({ sessionID: "s", requestID: "p", decision: "once" })
  await client.session.command({ sessionID: "s", name: "test", text: "args", delivery: "queue" })
  await client.session.form.cancel({ sessionID: "s", formID: "f" })
  assert.deepEqual(calls.slice(1), [
    { method: "POST", path: "/api/session/s/permission/p/reply", body: { decision: "once" } },
    { method: "POST", path: "/api/session/s/command", body: { name: "test", text: "args", delivery: "queue" } },
    { method: "DELETE", path: "/api/session/s/form/f", body: undefined },
  ])
})

test("errors never retry mutations; native error envelopes, abort and origin fencing survive", async () => {
  const endpoint = { url: "http://127.0.0.1:4321" }
  rememberRuntime(endpoint, { version: "2.0.11", pid: 2, discovery: "info" })
  let calls = 0
  for (const status of [400, 401, 404, 500]) {
    const envelope = { _tag: "NativeError", message: "fixture" }
    const fetch = createRuntimeFetch(endpoint, async () => { calls++; return Response.json(envelope, { status }) })
    const response = await fetch(`${endpoint.url}/api/session/s`, { method: "PATCH", body: '{"title":"fixture"}' })
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), envelope)
  }
  assert.equal(calls, 4)
  const controller = new AbortController()
  controller.abort()
  const fetch = createRuntimeFetch(endpoint, async () => { assert.fail("must not dispatch") })
  await assert.rejects(fetch(`${endpoint.url}/api/session/s`, { method: "PATCH", signal: controller.signal }), { name: "AbortError" })
  await assert.rejects(fetch("http://127.0.0.1:4322/api/session"), /origin mismatch/)
})
