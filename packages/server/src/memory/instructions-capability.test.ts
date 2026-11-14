import assert from "node:assert/strict"
import { test } from "node:test"
import { memoryInstructionsContract, readMemoryInstructionsCapability } from "./instructions-capability"

const entries = "/api/experimental/session/{sessionID}/instructions/entries"
const document = (): { openapi: string; paths: Record<string, Record<string, unknown>> } => ({
  openapi: "3.1.0", paths: { [entries]: { get: {} }, [`${entries}/{key}`]: { put: {}, delete: {} } },
})

test("optional instructions capability distinguishes valid absence from unreadable contracts", () => {
  assert.equal(memoryInstructionsContract(document()), "supported")
  for (const [path, method] of [[entries, "get"], [`${entries}/{key}`, "put"], [`${entries}/{key}`, "delete"]]) {
    const missing = document()
    delete (missing.paths[path!] as Record<string, unknown>)[method!]
    assert.equal(memoryInstructionsContract(missing), "unsupported")
  }
  assert.equal(memoryInstructionsContract({ openapi: "3.1.0", paths: {} }), "unsupported")
  for (const malformed of [null, [], {}, { paths: {} }, { openapi: "3.1.0", paths: [] }, { openapi: "3.1.0", paths: { [entries]: null } }]) {
    assert.equal(memoryInstructionsContract(malformed), "unavailable")
  }
})

test("authenticated probes coalesce per connection; authoritative answers are retained and reconnects requalify", async () => {
  let calls = 0, contract = document()
  const connection = { endpoint: { url: "http://127.0.0.1:4321", auth: { type: "basic" as const, username: "opencode", password: "fixture" } },
    fetch: (async (input, init) => {
      calls++
      assert.equal(String(input), "http://127.0.0.1:4321/openapi.json")
      assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("opencode:fixture").toString("base64")}`)
      assert.equal(init?.redirect, "error")
      return Response.json(contract)
    }) as typeof fetch, assertCurrent() {} }
  assert.deepEqual(await Promise.all([readMemoryInstructionsCapability(connection), readMemoryInstructionsCapability(connection)]), ["supported", "supported"])
  assert.equal(calls, 1)
  assert.equal(await readMemoryInstructionsCapability(connection), "supported")
  assert.equal(calls, 1)
  contract = { openapi: "3.1.0", paths: {} }
  const replacement = { ...connection }
  assert.equal(await readMemoryInstructionsCapability(replacement), "unsupported")
  assert.equal(await readMemoryInstructionsCapability(replacement), "unsupported")
  assert.equal(calls, 2)
  replacement.assertCurrent = () => { throw new Error("Stale connection") }
  await assert.rejects(readMemoryInstructionsCapability(replacement), /Stale connection/)
})

test("auth, discovery, malformed and transient failures never cache absence or trial a session mutation", async () => {
  for (const failure of [401, 403, 404, 500, "network", "malformed", "oversized"]) {
    let calls = 0
    const connection = { endpoint: { url: "http://127.0.0.1:4321" }, assertCurrent() {}, fetch: (async (_input, init) => {
      assert.equal(init?.method ?? "GET", "GET")
      if (++calls > 1) return Response.json(document())
      if (failure === "network") throw new Error("Transient fixture failure")
      if (failure === "malformed") return Response.json({ paths: {} })
      if (failure === "oversized") return new Response("x".repeat(8 * 1024 * 1024 + 1))
      return new Response(null, { status: failure as number })
    }) as typeof fetch }
    assert.equal(await readMemoryInstructionsCapability(connection), failure === 401 || failure === 403 ? "authentication" : "unavailable")
    assert.equal(await readMemoryInstructionsCapability(connection), "supported")
    assert.equal(calls, 2)
  }
})
