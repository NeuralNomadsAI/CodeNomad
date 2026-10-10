import assert from "node:assert/strict"
import test from "node:test"
import { serverApi } from "./api-client"
import { HttpResponseError } from "./retryable-file-search"
import { isDefinitiveCreationRejection, isUncertainCreation, missionMutationCode, MissionMutationError, missionMutationErrorKey } from "./mission-mutation"

test("Mission mutation classification distinguishes held creation, capacity, scope and actual revision conflicts", () => {
  const key = (status: number, code: ConstructorParameters<typeof MissionMutationError>[2]) => missionMutationErrorKey(new MissionMutationError(status, "create", code))
  assert.equal(key(409, "creation-uncertain"), "missions.control.creation.uncertain")
  assert.equal(key(503, "creation-capacity"), "missions.control.creation.capacity")
  assert.equal(key(409, "creation-conflict"), "missions.control.creation.scopeConflict")
  assert.equal(key(409, "revision-conflict"), "missions.control.mutation.conflict")
  assert.equal(key(409, "request-conflict"), "missions.control.mutation.requestConflict")
  assert.equal(key(403, undefined), "missions.control.mutation.forbidden")
  for (const error of [new MissionMutationError(409, "create"), new HttpResponseError("private detail", 409, null),
    new MissionMutationError(503, "create", "creation-uncertain"), new Error("private credentials")]) {
    assert.equal(missionMutationErrorKey(error), "missions.control.mutation.error")
    assert.equal(isUncertainCreation(error), false)
  }
})

test("only a received reviewed rejection is a definitive creation outcome; transport, decode and unknown statuses stay uncertain", () => {
  const create = (status: number, code?: ConstructorParameters<typeof MissionMutationError>[2]) => new MissionMutationError(status, "create", code)
  for (const error of [create(400), create(401), create(403), create(404), create(409, "creation-conflict"), create(503, "creation-capacity"),
    create(409, "revision-conflict"), create(409, "request-conflict")]) assert.equal(isDefinitiveCreationRejection(error), true, `${error.status} ${error.code}`)
  for (const error of [new TypeError("fetch failed"), new SyntaxError("truncated JSON"), create(409, "creation-uncertain"), create(409),
    create(500), create(502), create(503), create(504), new MissionMutationError(400, "edit"), new Error("private"), undefined]) {
    assert.equal(isDefinitiveCreationRejection(error), false, String(error))
  }
})

test("lost fetch and undecodable create acknowledgements surface as non-definitive without a second request", async t => {
  let calls = 0, mode: "reject" | "truncated" | "shape" = "reject"
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    if (mode === "reject") throw new TypeError("fetch failed")
    return new Response(mode === "truncated" ? '{"mission":{"id":' : JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })
  })
  const input = { objective: "Original", template: "custom" as const, requestId: "original-request" }
  for (const next of ["reject", "truncated", "shape"] as const) {
    mode = next
    await assert.rejects(serverApi.createMission("private-fixture", input), error => { assert.equal(isDefinitiveCreationRejection(error), false, next); return true })
  }
  assert.equal(calls, 3)
})

test("only allowlisted codes survive, and edit cannot manufacture a creation hold", () => {
  for (const body of [null, "private text", { code: "source-secret" }, { code: {} }, { error: "creation-uncertain" }]) {
    assert.equal(missionMutationCode(body, "create"), undefined)
  }
  assert.equal(missionMutationCode({ code: "creation-uncertain", error: "private text" }, "create"), "creation-uncertain")
  assert.equal(missionMutationCode({ code: "creation-uncertain" }, "edit"), undefined)
  assert.equal(missionMutationCode({ code: "revision-conflict" }, "edit"), "revision-conflict")
})

test("actual create/edit HTTP adapters retain redacted classification without source text or mutation replay", async t => {
  let calls = 0
  let code = "creation-uncertain", status = 409
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    return Response.json({ code, error: "private-source-credential", message: "private upstream text" }, { status })
  })
  const input = { objective: "Original", template: "custom" as const, requestId: "original-request" }
  await assert.rejects(serverApi.createMission("private-fixture", input), error => {
    assert.ok(error instanceof MissionMutationError)
    assert.equal(error.code, "creation-uncertain"); assert.equal(error.message, "Mission change was not confirmed")
    assert.ok(!JSON.stringify(error).includes("private")); return true
  })
  code = "source-secret"
  await assert.rejects(serverApi.createMission("private-fixture", input), error => {
    assert.ok(error instanceof MissionMutationError); assert.equal(error.code, undefined); return true
  })
  code = "revision-conflict"
  await assert.rejects(serverApi.editMission("private-fixture", "mission", { objective: "Edit", expectedRevision: 1, requestId: "edit-original" }), error => {
    assert.equal(missionMutationErrorKey(error), "missions.control.mutation.conflict"); return true
  })
  code = "creation-capacity"; status = 503
  await assert.rejects(serverApi.createMission("private-fixture", input), error => {
    assert.equal(missionMutationErrorKey(error), "missions.control.creation.capacity"); return true
  })
  assert.equal(calls, 4)
})
