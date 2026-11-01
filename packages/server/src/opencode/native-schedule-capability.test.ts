import assert from "node:assert/strict"
import test from "node:test"
import { NativeScheduleCapabilityReader, nativeScheduleCapability } from "./native-schedule-capability"
import { nativeScheduleContractFixture as contract } from "./native-schedule-capability-fixture"

test("native schedule availability recognizes consumed shapes independently of versions and flag values", () => {
  assert.deepEqual(nativeScheduleCapability(contract()), { available: true })
  const optionalWhen = contract()
  optionalWhen.components.schemas["Schedule.CreatePayload"].required = ["sessionID", "prompt"]
  assert.deepEqual(nativeScheduleCapability(optionalWhen), { available: true })
  const future = { ...contract(), info: { version: "99.0.0-future" } }
  assert.deepEqual(nativeScheduleCapability(future), { available: true })
  assert.deepEqual(nativeScheduleCapability({}), { available: false, reason: "missing-api" })
  for (const mutate of [
    (value: any) => { delete value.paths["/api/experimental/schedule"].get.parameters },
    (value: any) => { value.paths["/api/experimental/schedule"].get.parameters = [null] },
    (value: any) => { value.components.schemas["Schedule.Info"].properties.runCount.type = "string" },
    (value: any) => { value.components.schemas["Schedule.Info"].type = "string" },
    (value: any) => { value.components.schemas["Schedule.CreatePayload"].type = "string" },
    (value: any) => { value.components.schemas["Schedule.CreatePayload"].properties.ends.type = "string" },
    (value: any) => { value.components.schemas["Schedule.Info"].properties.time.type = "string" },
    (value: any) => { value.paths["/api/experimental/schedule"].post.responses["200"].content["application/json"].schema.type = "string" },
    (value: any) => { value.components.schemas["Schedule.Info"].properties.status.enum = "active" },
    (value: any) => { value.components.schemas["Schedule.Info"].required = 3 },
    (value: any) => { value.components.schemas["Schedule.When"].anyOf.pop() },
    (value: any) => { value.components.schemas["Schedule.CreatePayload"].properties.when.anyOf.pop() },
    (value: any) => { delete value.components.schemas["Schedule.CreatePayload"].properties.when },
    (value: any) => { delete value.components.schemas["Config.InfoEncoded"].properties.experimental.properties.schedules },
    (value: any) => { delete value.paths["/api/experimental/schedule/{scheduleID}"].delete.responses["204"] },
  ]) {
    const value = contract(); mutate(value)
    assert.deepEqual(nativeScheduleCapability(value), { available: false, reason: "incompatible-contract" })
  }
})

test("identical inline request/response structures qualify like refs, while malformed consumed structures refuse", () => {
  const value = contract(), schemas = value.components.schemas as Record<string, any>
  const inline = (input: any): any => {
    if (!input || typeof input !== "object") return input
    if (Array.isArray(input)) return input.map(inline)
    if (typeof input.$ref === "string") return inline(schemas[input.$ref.slice("#/components/schemas/".length)])
    return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, inline(child)]))
  }
  value.paths = inline(value.paths)
  assert.deepEqual(nativeScheduleCapability(value), { available: true })
  value.paths["/api/experimental/schedule"].post.requestBody.content["application/json"].schema.description = "Equivalent inline schema"
  assert.deepEqual(nativeScheduleCapability(value), { available: true })
  value.paths["/api/experimental/schedule/{scheduleID}"].get.responses["200"].content["application/json"].schema.properties.data.properties.runCount.type = "string"
  assert.deepEqual(nativeScheduleCapability(value), { available: false, reason: "incompatible-contract" })
})

test("read-only reader keeps API support, effective per-Location flag and origin separate and fences replacement", async () => {
  let current = true, owned = true, requests = 0, enabled = false
  const connection: any = { endpoint: { url: "http://127.0.0.1:1234" }, assertCurrent() { if (!current) throw Error("replaced") },
    fetch: async (url: URL, options: RequestInit) => {
      requests++; assert.equal(url.pathname, "/openapi.json"); assert.equal(options.method, undefined)
      return Response.json(contract())
    } }
  const documents: any = { readConfigDocuments: async () => {
    if (!owned) throw Error("unowned")
    return { location: { directory: "/project" }, documents: [], entries: [
      { type: "document", path: "/global/opencode.jsonc", info: { experimental: { schedules: true } } },
      { type: "document", path: "/project/opencode.jsonc", info: { experimental: enabled ? { schedules: true } : { subagent_depth: 8 } } },
    ] }
  } }
  const reader = new NativeScheduleCapabilityReader(documents, { getSharedServiceConnection: async () => connection } as any)
  const snapshot = await reader.read("w", { directory: "/project" })
  assert.deepEqual(snapshot.api, { available: true }); assert.equal(snapshot.enabled, false)
  assert.equal(snapshot.origin, "/project/opencode.jsonc")
  enabled = true; assert.equal((await reader.read("w", { directory: "/project" })).enabled, true)
  owned = false; const before = requests
  await assert.rejects(reader.read("w", { directory: "/other" }), /unowned/); assert.equal(requests, before)
  owned = true; current = false
  await assert.rejects(reader.read("w", { directory: "/project" }), /replaced/)
})
