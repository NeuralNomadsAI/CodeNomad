import assert from "node:assert/strict"
import { test } from "node:test"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { CODENOMAD_MISSIONS_RPC } from "../missions/rpc"
import { MISSION_SCHEDULE_CARRIER_SESSION_PREFIX } from "../missions/mission-schedule-carrier-identity"
import { assertOrdinaryMissionScheduleBody, assertOrdinaryMissionScheduleSession, MissionScheduleInputError } from "./mission-schedule-input-guard"
import { NATIVE_SCHEDULE_CARRIER_MODEL, NATIVE_SCHEDULE_CARRIER_TITLE } from "../opencode/missions/native-schedule-carrier"

const session = { id: "ses_ordinary", location: { directory: "/owned/worktree" } }
const denied = (statusCode: number) => (error: unknown) => error instanceof MissionScheduleInputError && error.statusCode === statusCode
const client = (read: (...args: any[]) => Promise<unknown>) => ({
  rpc: (definition: unknown) => { assert.equal(definition, CODENOMAD_MISSIONS_RPC); return { scheduleCarrierRead: read } },
}) as unknown as OpenCodeClient

test("exact durable ownership blocks an unmarked carrier; ordinary sessions use their actual Location", async () => {
  const calls: unknown[] = []
  const ordinary = client(async (input, options) => { calls.push([input, options.location]); return { owned: false } })
  await assertOrdinaryMissionScheduleSession(ordinary, session)
  assert.deepEqual(calls, [[{ sessionID: session.id }, { directory: session.location.directory }]])
  await assert.rejects(assertOrdinaryMissionScheduleSession(client(async () => ({ owned: true })), session), denied(403))
  for (const marker of [null, false, {}, { missionID: "forged" }]) {
    await assert.rejects(assertOrdinaryMissionScheduleSession(ordinary, {
      ...session, metadata: { "codenomad.schedule-carrier": marker },
    }), denied(403))
  }
  assert.equal(calls.length, 1, "reserved markers reject before any RPC")
})

test("structured method absence preserves legacy behavior; malformed and indeterminate ownership stay closed", async () => {
  await assertOrdinaryMissionScheduleSession(client(async () => { throw { type: "rpc.method_not_found" } }), session)
  for (const failure of [new Error("rpc.method_not_found"), { type: "rpc.unavailable" }, { type: "rpc.failed" },
    { type: "rpc.unavailable", message: "" }, { type: "rpc.unavailable", message: "Absent", data: { unknown: true } },
    { type: "rpc.unavailable", message: "Absent", status: 404 }, { cause: { type: "rpc.unavailable", message: "Absent" } },
    { status: 404 }, { status: 401 }, new DOMException("Native read timed out", "TimeoutError"), new Error("private native read failure")]) {
    await assert.rejects(assertOrdinaryMissionScheduleSession(client(async () => { throw failure }), session), denied(503))
  }
  for (const output of [undefined, null, false, {}, { owned: "false" }]) {
    await assert.rejects(assertOrdinaryMissionScheduleSession(client(async () => output), session), denied(503))
  }
})

test("public SDK qualified RpcError absence allows ordinary sessions without caching or generic HTTP fallback", async () => {
  let missing = true, reads = 0
  const sdk = OpenCode.make({ baseUrl: "http://isolated-sdk.invalid", fetch: async (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).pathname, "/api/rpc/codenomad.missions/scheduleCarrierRead")
    assert.deepEqual(await request.json(), { input: { sessionID: session.id } })
    reads++
    return missing ? Response.json({ _tag: "RpcError", type: "rpc.unavailable", message: "RPC unavailable" }, { status: 400 })
      : Response.json({ output: { owned: true } })
  } })
  await assertOrdinaryMissionScheduleSession(sdk, session)
  await assertOrdinaryMissionScheduleSession(sdk, session)
  assert.equal(reads, 2)
  missing = false
  await assert.rejects(assertOrdinaryMissionScheduleSession(sdk, session), denied(403))
  for (const status of [404, 503]) {
    const ambiguous = OpenCode.make({ baseUrl: "http://isolated-sdk.invalid", fetch: async () =>
      Response.json({ type: "rpc.unavailable", message: "not a native RpcError envelope" }, { status }) })
    await assert.rejects(assertOrdinaryMissionScheduleSession(ambiguous, session), denied(503))
  }
})

test("qualified absent registration keeps reserved IDs, markers, model/title hints and stale fences closed", async () => {
  const absent = client(async () => { throw { type: "rpc.unavailable", message: "RPC unavailable" } })
  for (const candidate of [{ ...session, id: `${MISSION_SCHEDULE_CARRIER_SESSION_PREFIX}${"a".repeat(40)}` },
    { ...session, metadata: { "codenomad.schedule-carrier": {} } }])
    await assert.rejects(assertOrdinaryMissionScheduleSession(absent, candidate), denied(403))
  for (const candidate of [{ ...session, model: NATIVE_SCHEDULE_CARRIER_MODEL }, { ...session, title: NATIVE_SCHEDULE_CARRIER_TITLE }])
    await assert.rejects(assertOrdinaryMissionScheduleSession(absent, candidate), denied(503))
  let completed = false
  const stale = client(async () => { completed = true; throw { type: "rpc.unavailable", message: "RPC unavailable" } })
  await assert.rejects(assertOrdinaryMissionScheduleSession(stale, session,
    { current: () => { if (completed) throw new Error("Changed connection or Location") } }), /Changed connection or Location/)
  const controller = new AbortController()
  await assert.rejects(assertOrdinaryMissionScheduleSession(client(async () => {
    controller.abort(); throw { type: "rpc.unavailable", message: "RPC unavailable" }
  }), session, { signal: controller.signal }), { name: "AbortError" })
})

test("a missing method cannot silently treat a potential carrier with its marker removed as a journal-only session", async () => {
  const old = client(async () => { throw { type: "rpc.method_not_found" } })
  for (const hint of [{ model: NATIVE_SCHEDULE_CARRIER_MODEL }, { title: NATIVE_SCHEDULE_CARRIER_TITLE }]) {
    await assert.rejects(assertOrdinaryMissionScheduleSession(old, { ...session, ...hint }), denied(503))
    await assertOrdinaryMissionScheduleSession(client(async () => ({ owned: false })), { ...session, ...hint })
  }
})

test("the reserved schedule carrier namespace stays denied after every mutable hint is removed, without inferring membership", async () => {
  let reads = 0
  for (const missing of [false, true]) {
    const rpc = client(async () => {
      reads++
      if (missing) throw { type: "rpc.method_not_found" }
      return { owned: false }
    })
    for (const suffix of ["a".repeat(40), "not-a-native-identity", ""]) {
      await assert.rejects(assertOrdinaryMissionScheduleSession(rpc, {
        id: `${MISSION_SCHEDULE_CARRIER_SESSION_PREFIX}${suffix}`, location: session.location,
      }), denied(403))
    }
  }
  assert.equal(reads, 0, "reserved input is denied independently of an ownership answer or missing method")
  const old = client(async () => { throw { type: "rpc.method_not_found" } })
  for (const id of ["ses_cn_schedule", "ses_cn_schedules_ordinary", `ses_ordinary_${MISSION_SCHEDULE_CARRIER_SESSION_PREFIX}`]) {
    await assertOrdinaryMissionScheduleSession(old, { ...session, id })
  }
})

test("connection and cancellation fences win even over an ordinary or missing-method answer", async () => {
  for (const missing of [false, true]) {
    const controller = new AbortController()
    await assert.rejects(assertOrdinaryMissionScheduleSession(client(async () => {
      controller.abort()
      if (missing) throw { type: "rpc.method_not_found" }
      return { owned: false }
    }), session, { signal: controller.signal }), { name: "AbortError" })
    let reads = 0
    await assert.rejects(assertOrdinaryMissionScheduleSession(client(async () => {
      reads++
      if (missing) throw { type: "rpc.method_not_found" }
      return { owned: false }
    }), session, { current: () => { if (reads) throw new Error("stale connection") } }), /stale connection/)
  }
})

test("ordinary metadata is preserved, while reserved metadata is refused throughout imported sources", () => {
  const ordinary = { text: "metadata.schedule is just text", metadata: { trace: "kept" } }
  const before = structuredClone(ordinary)
  assertOrdinaryMissionScheduleBody(ordinary)
  assert.deepEqual(ordinary, before)
  for (const metadata of [{ schedule: {} }, { schedule: null }, { "codenomad.schedule-carrier": {} }]) {
    assert.throws(() => assertOrdinaryMissionScheduleBody({ metadata }), denied(403))
    for (const body of [{ info: { metadata } }, { messages: [{ metadata }] },
      { messages: [{ type: "user", source: { messages: [{ source: { metadata } }] } }] }]) {
      assert.throws(() => assertOrdinaryMissionScheduleBody(body, true), denied(403))
    }
  }
  for (const body of [null, "opaque", Buffer.from("{}"), []]) assert.throws(() => assertOrdinaryMissionScheduleBody(body), denied(400))
  assertOrdinaryMissionScheduleBody(undefined)
})
