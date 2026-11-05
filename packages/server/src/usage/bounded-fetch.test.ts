import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { fetchBoundedJson, postBoundedJson } from "./bounded-fetch"

test("bounded transport keeps GET callers and supports JSON/form POSTs, forcing redirect refusal", async t => {
  const requests: RequestInit[] = []
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init!)
    return Response.json({ read: true })
  })
  const signal = AbortSignal.timeout(2000)
  const url = "https://simulated.invalid"
  assert.deepEqual(await fetchBoundedJson(url, { Accept: "application/json" }, signal), { read: true })
  await postBoundedJson(url, {}, { project: "fake-project" }, signal)
  await postBoundedJson(url, {}, new URLSearchParams({ refresh_token: "fake-refresh" }), signal)
  await fetchBoundedJson(url, {}, signal, undefined, { redirect: "follow" })
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
    await assert.rejects(postBoundedJson(`http://127.0.0.1:${address.port}/token`, {},
      new URLSearchParams({ refresh_token: "fake-only" }), AbortSignal.timeout(2000)))
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
