import assert from "node:assert/strict"
import test from "node:test"
import { HttpResponseError } from "./retryable-file-search"
import { isRejectedLifecycleIntent, missionLifecycleRequest, MissionLifecycleRequestError } from "./mission-lifecycle-request"

test("only a lifecycle transport's typed 409 revision rejection proves pre-intent non-admission", () => {
  assert.equal(isRejectedLifecycleIntent(new MissionLifecycleRequestError(409, "revision-conflict")), true)
  for (const error of [new MissionLifecycleRequestError(409), new MissionLifecycleRequestError(409, "request-conflict"),
    new MissionLifecycleRequestError(409, "control-conflict"), new MissionLifecycleRequestError(503, "control-pending"),
    new MissionLifecycleRequestError(503, "revision-conflict"), new HttpResponseError("revision-conflict", 409, null),
    new Error("revision-conflict"), { status: 409, code: "revision-conflict" }, null]) {
    assert.equal(isRejectedLifecycleIntent(error), false)
  }
})

test("lifecycle HTTP transport retains allowlisted codes and exact input without replay or upstream text", async t => {
  const input = { action: "pause" as const, expectedRevision: 1, requestId: "original-intent" }
  const calls: { url: string; init?: RequestInit }[] = []
  let status = 409, body: unknown = { code: "revision-conflict", error: "secret-original-body" }
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init }); return Response.json(body, { status })
  })
  for (const code of ["revision-conflict", "request-conflict", "control-conflict", "control-pending", "private-unrecognized", undefined]) {
    body = { code, error: "secret-original-body" }
    await assert.rejects(missionLifecycleRequest("/private-fixture/control", input), error => {
      assert.ok(error instanceof MissionLifecycleRequestError)
      assert.equal(error.code, code === "private-unrecognized" ? undefined : code)
      assert.equal(error.message, "Mission control was not confirmed")
      assert.equal(isRejectedLifecycleIntent(error), code === "revision-conflict")
      assert.equal(JSON.stringify(error).includes("secret"), false)
      return true
    })
  }
  status = 503; body = { code: "revision-conflict" }
  await assert.rejects(missionLifecycleRequest("/private-fixture/control", input), error => !isRejectedLifecycleIntent(error))
  assert.equal(calls.length, 7)
  for (const call of calls) {
    assert.equal(call.url, "/private-fixture/control")
    assert.equal(call.init?.method, "POST")
    assert.equal(call.init?.body, JSON.stringify(input))
    assert.equal(call.init?.credentials, "include")
  }
})

test("malformed response and lost acknowledgement stay uncertain, without manufacturing a rejection", async t => {
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("revision-conflict", { status: 409 }) })
  const input = { action: "stop" as const, expectedRevision: 7, requestId: "original-stop" }
  await assert.rejects(missionLifecycleRequest("/private-fixture/control", input), error => {
    assert.ok(error instanceof MissionLifecycleRequestError)
    assert.equal(error.code, undefined); assert.equal(isRejectedLifecycleIntent(error), false); return true
  })
  const lost = new TypeError("connection lost after admission")
  t.mock.method(globalThis, "fetch", async () => { calls++; throw lost })
  await assert.rejects(missionLifecycleRequest("/private-fixture/control", input), error => error === lost && !isRejectedLifecycleIntent(error))
  assert.equal(calls, 2)
})
