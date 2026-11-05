import assert from "node:assert/strict"
import { test } from "node:test"
import { createRuntimeFetch } from "./transport"
import { rememberRuntime } from "./runtime"
import { explicitContractFixture, legacyContractFixture, modernContractFixture } from "./contract-fixture"
import { UnsupportedOpenCodeError } from "../runtime-support"
import { negotiateRuntime } from "./negotiate"

test("unknown contracts perform authenticated bounded read negotiation before any mutation", async () => {
  for (const kind of ["unauthorized", "unrecognized", "oversized"] as const) {
    const endpoint = { url: "http://127.0.0.1:4321", auth: { type: "basic" as const, username: "opencode", password: "fixture" } }
    rememberRuntime(endpoint, { version: "2.2.100", pid: 1, discovery: "status" })
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
  // A 2.0.x-shaped replay contract under an unfamiliar label: `state` and compaction `recent`.
  const preNative = structuredClone(modernContractFixture) as any
  preNative.components.schemas["Session.Message.Assistant.Text"] = { properties: { type: {}, text: {}, state: {} } }
  preNative.components.schemas["Session.Message.Compaction.Completed"] = { properties: { type: {}, metadata: {}, providerState: {}, summary: {}, recent: {} } }
  for (const [schema, reason] of [[legacyContractFixture, "canonical_api"], [missingEnvironment, "session_environment"], [preNative, "native_contract"]] as const) {
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
  rememberRuntime(endpoint, { version: "2.2.100", pid: 1, discovery: "info" })
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

const session = "/api/session/{sessionID}"
const response = (schema: any, route: string) => schema.paths[route].get.responses["200"].content["application/json"].schema.properties
const request = (schema: any, route: string) => schema.paths[route].post.requestBody.content["application/json"].schema.properties
const missingFields: [string, (schema: any) => void][] = [
  ["agent request.agent", schema => { delete request(schema, `${session}/agent`).agent }],
  ["agent string", schema => { request(schema, `${session}/agent`).agent.type = "number" }],
  ["model request.model", schema => { delete request(schema, `${session}/model`).model }],
  ...["id", "providerID", "variant"].map(field => [`model ${field}`, (schema: any) => { delete schema.components.schemas["Model.Ref"].properties[field] }] as [string, (schema: any) => void]),
  ["model providerID string", schema => { schema.components.schemas["Model.Ref"].properties.providerID.type = "number" }],
  ...["mcp", "skill"].flatMap(route => [
    [`${route} query location`, (schema: any) => { delete schema.paths[`/api/${route}`].get.parameters }],
    [`${route} query directory`, (schema: any) => { delete schema.paths[`/api/${route}`].get.parameters[0].schema.anyOf[0].properties.directory }],
    [`${route} query directory string`, (schema: any) => { schema.paths[`/api/${route}`].get.parameters[0].schema.anyOf[0].properties.directory = { type: "number" } }],
    [`${route} response data`, (schema: any) => { delete response(schema, `/api/${route}`).data }],
    [`${route} response array`, (schema: any) => { response(schema, `/api/${route}`).data.type = "object" }],
    [`${route} response items`, (schema: any) => { delete response(schema, `/api/${route}`).data.items }],
  ] as [string, (schema: any) => void][]),
  ["mcp response location", schema => { delete response(schema, "/api/mcp").location }],
  ["response location.directory", schema => { delete schema.components.schemas["Location.PublicRef"].properties.directory }],
  ["response location.directory string", schema => { schema.components.schemas["Location.PublicRef"].properties.directory.type = "number" }],
  ...["id", "name"].map(field => [`skill ${field}`, (schema: any) => { delete schema.components.schemas["Skill.Info"].properties[field] }] as [string, (schema: any) => void]),
  ...["name", "status"].map(field => [`mcp ${field}`, (schema: any) => { delete schema.components.schemas["Mcp.Server"].properties[field] }] as [string, (schema: any) => void]),
  ["mcp nested status", schema => { delete schema.components.schemas["Mcp.Server"].properties.status.anyOf[0].properties.status }],
]
for (const [route, method] of [[`${session}/agent`, "post"], [`${session}/model`, "post"], ["/api/mcp", "get"], ["/api/skill", "get"]]) {
  missingFields.push([`${method} ${route}`, schema => { delete schema.paths[route!][method!] }])
}
for (const [name, remove] of missingFields) test(`explicit E1 refuses missing consumed contract: ${name}`, async () => {
  const schema = explicitContractFixture(); remove(schema)
  const calls: string[] = []
  await assert.rejects(negotiateRuntime({ url: "http://127.0.0.1:4321" }, async input => {
    calls.push(new URL(String(input)).pathname)
    return Response.json(schema)
  }, new AbortController().signal, "explicit-e1"), { code: "missing_contract", reason: "canonical_api" })
  assert.deepEqual(calls, ["/openapi.json"])
})

test("explicit E1 admits compatible future schemas without optional enrichment or optional catalogue display fields", async () => {
  const schema = explicitContractFixture()
  delete schema.components.schemas["Skill.Info"].properties.description
  delete response(schema, "/api/skill").location
  delete schema.components.schemas["Mcp.Server"].properties.status.anyOf[1].properties.error
  assert.equal(await negotiateRuntime({ url: "http://127.0.0.1:4321" }, async () => Response.json(schema),
    new AbortController().signal, "explicit-e1"), "modern")
})
