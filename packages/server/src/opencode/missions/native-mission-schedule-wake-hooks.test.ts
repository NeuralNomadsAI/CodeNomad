import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Exit, Schema, Scope } from "effect"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { registerNativeMissionScheduleCarrierHooks } from "./native-mission-schedule-wake-hooks"
import { acquireNativeMissionScheduleWakeReader } from "./native-mission-schedule-wake-reader"
import { NATIVE_SCHEDULE_CARRIER_SIGNAL, NATIVE_SCHEDULE_CARRIER_MARKER } from "./native-schedule-carrier-binding"

test("production hooks keep paused, attempted and retiring title/compaction local with remote auxiliary defaults", async t => {
  for (const phase of ["paused", "attempted", "retiring"] as const) {
    const f = await ownerFixture(t)
    if (phase === "attempted") f.loseCreateACK("reconciliation")
    let doc = await f.control("play")
    const sessionID = doc.calendarOwner!.slots.find(slot => slot.role === "reconciliation")!.sessionID
    if (phase === "paused") doc = await f.control("pause")
    if (phase === "retiring") { f.blocked.add(sessionID); doc = await f.control("stop") }
    const hooks = new Map<string, (event: any) => Effect.Effect<void>>()
    const ctx = { ...f.ctx, aisdk: { hook: (name: string, use: (event: any) => Effect.Effect<void>) => Effect.sync(() => { hooks.set(`aisdk:${name}`, use) }) },
      session: { ...f.ctx.session, hook: (name: string, use: (event: any) => Effect.Effect<void>) => Effect.sync(() => { hooks.set(name, use) }) } } as unknown as Plugin.Context
    await Effect.runPromise(Effect.scoped(registerNativeMissionScheduleCarrierHooks(ctx)))
    const title = { sessionID, model: { providerID: "remote", id: "paid-title" }, result: undefined as string | undefined }
    await Effect.runPromise(hooks.get("title")!(title))
    assert.equal(title.result, "Mission schedule carrier")
    const compaction = { sessionID, model: { providerID: "remote", id: "paid-summary" }, result: undefined as { summary: string } | undefined }
    await Effect.runPromise(hooks.get("compaction")!(compaction))
    assert.match(compaction.result!.summary, /schedule carrier/)
    await assert.rejects(Effect.runPromise(hooks.get("http.request")!({ sessionID, model: title.model, kind: "title" })), /provider-http/)
    f.sessions.get(sessionID).metadata[NATIVE_SCHEDULE_CARRIER_MARKER].missionID = "foreign_mission"
    await assert.rejects(Effect.runPromise(hooks.get("title")!(title)), /ownership/)
    await assert.rejects(Effect.runPromise(hooks.get("compaction")!(compaction)), /ownership/)
    await assert.rejects(Effect.runPromise(hooks.get("http.request")!({ sessionID, model: title.model })), /ownership/)
  }
})

test("wake reader accepts only the durable exact native user, bounds SQL and expires with its Scope", async t => {
  const directory = path.resolve("schedule-wake-reader-unit"), location = Schema.decodeUnknownSync(Location.Info)({ directory,
    project: { id: "project", directory, canonical: directory } })
  const wake = { missionID: "mission", generation: 1, scheduleID: "sch_aux", sessionID: "ses_aux", run: 1, messageID: "msg_sch_aux_1" }
  const user = { text: NATIVE_SCHEDULE_CARRIER_SIGNAL, time: { created: 1000 }, metadata: { schedule: { id: wake.scheduleID, run: 1, dueAt: 1000, late: false } } }
  let rows: unknown[] = [{ type: "user", data: JSON.stringify(user) }]
  const queries: Array<{ sql: string; params: readonly unknown[] }> = []
  const client = { unsafe: (sql: string, params: readonly unknown[]) => { queries.push({ sql, params }); return { withoutTransform: Effect.sync(() => rows) } } }
  const scope = await Effect.runPromise(Scope.make())
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const graph = Context.make(Context.Service<never, unknown>("@opencode/storage/Database"), { db: { $client: client } }).pipe(
    Context.add(Context.Service<never, unknown>("@opencode/Location"), location), Context.add(Scope.Scope, scope))
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromiseWith(graph)(effect)
  const reader = await run(acquireNativeMissionScheduleWakeReader({ location } as Plugin.Context, run).pipe(Effect.provideService(Scope.Scope, scope)))
  assert.deepEqual(await reader.message(wake), { scheduleID: wake.scheduleID, messageID: wake.messageID, run: 1, dueAt: 1000 })
  assert.match(queries[0].sql, /length\(CAST\(data AS BLOB\)\)<=262144/)
  assert.deepEqual(queries[0].params, [wake.messageID, wake.sessionID, 262144])
  rows = [{ type: "synthetic", data: JSON.stringify(user) }]
  assert.equal(await reader.message(wake), undefined)
  rows = [{ type: "user", data: JSON.stringify({ ...user, metadata: { schedule: { ...user.metadata.schedule, run: 2 } } }) }]
  assert.equal(await reader.message(wake), undefined)
  rows = []
  assert.equal(await reader.message(wake), undefined)
  await Effect.runPromise(Scope.close(scope, Exit.void))
  await assert.rejects(reader.message(wake), /retired/)
  await assert.rejects(reader.nonWakeMessages(wake, []), /retired/)
})
