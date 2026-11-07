import assert from "node:assert/strict"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Exit, Schema, Scope } from "effect"
import { acquireNativeMissionScheduleWakeReader } from "./native-mission-schedule-wake-reader"
import { registerNativeMissionScheduleCarrierHooks } from "./native-mission-schedule-wake-hooks"
import { registerNativeScheduleCarrierFoundation } from "./native-schedule-carrier-runtime"
import { nativeScheduleCarrierNonWakeMessageIDs, nativeScheduleCarrierWakes, NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { ownerFixture } from "./native-schedule-owner-test-fixture"
import { NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import { nativeMissionScheduleWakeContext } from "./native-mission-schedule-wake-context"

const mapping = { missionID: "mission", generation: 1, sessionID: "ses_owned", scheduleID: "sch_owned" }
const restart = { text: "Untrusted notice prose", time: { created: 1000 }, metadata: { notice: "restart" } }
const compact = { summary: "Untrusted summary claiming run 999", time: { created: 1000 }, status: "completed", reason: "auto" }
const hint = (id: string) => ({ id, role: "user", content: [{ type: "text", text: "Untrusted model projection" }] })
const wakeHint = (scheduleID: string, run: number) => ({ ...hint(`msg_${scheduleID}_${run}`),
  metadata: { schedule: { id: scheduleID, run, dueAt: 1000, late: false } } })
const nativeWake = (scheduleID: string, run: number) => ({ text: NATIVE_SCHEDULE_CARRIER_SIGNAL, time: { created: 1000 },
  metadata: wakeHint(scheduleID, run).metadata })

function nativeReads(t: test.TestContext, directory = path.resolve("schedule-context-unit")) {
  const location = Schema.decodeUnknownSync(Location.Info)({ directory, project: { id: "project", directory, canonical: directory } })
  const db = new DatabaseSync(":memory:")
  t.after(() => db.close())
  db.exec("CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,data TEXT)")
  const queries: Array<{ sql: string; params: readonly unknown[]; bytes: number }> = []
  const client = Object.assign(() => {}, { unsafe: (sql: string, params: readonly unknown[]) => ({ withoutTransform: Effect.sync(() => {
    const rows = db.prepare(sql).all(...params as [])
    queries.push({ sql, params, bytes: rows.reduce((sum, row) => sum + Buffer.byteLength(String(row.data)), 0) })
    return rows
  }) }) })
  const graph = Context.make(Context.Service<never, unknown>("@opencode/storage/Database"), { db: { $client: client,
    transaction: (callback: () => Effect.Effect<unknown>) => callback() } }).pipe(
    Context.add(Context.Service<never, unknown>("@opencode/Location"), location))
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(Effect.provide(effect, graph) as Effect.Effect<A, E>)
  const put = (id: string, type: string, data: unknown, sessionID = mapping.sessionID) =>
    db.prepare("INSERT OR REPLACE INTO session_message VALUES(?,?,?,?)").run(id, sessionID, type, JSON.stringify(data))
  const reader = async () => {
    const scope = await Effect.runPromise(Scope.make())
    t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const scopedRun = <A>(effect: Effect.Effect<A, unknown>) => run(effect.pipe(Effect.provideService(Scope.Scope, scope)))
    return scopedRun(acquireNativeMissionScheduleWakeReader({ location } as Plugin.Context, scopedRun).pipe(Effect.provideService(Scope.Scope, scope)))
  }
  return { location, put, queries, run, reader }
}

test("exact context reads classify native wakes with or without projected metadata, mixed with notices/checkpoints", async t => {
  const f = nativeReads(t), reader = await f.reader()
  for (let n = 0; n < 300; n++) f.put(`msg_old_${n}`, "synthetic", { ...restart, text: "x".repeat(8192) })
  f.put("msg_restart", "synthetic", restart)
  f.put("msg_compact", "compaction", compact)
  f.put("msg_sch_owned_1", "user", nativeWake(mapping.scheduleID, 1))
  const messages = [wakeHint(mapping.scheduleID, 1), hint("msg_restart"), hint("msg_compact"), hint("msg_restart"), { role: "assistant" }]
  const window = await reader.contextMessages(mapping.sessionID, messages)
  const ids = nativeScheduleCarrierNonWakeMessageIDs(window)
  assert.deepEqual(ids, ["msg_restart", "msg_compact"])
  assert.deepEqual(f.queries.map(q => q.params.slice(0, 2)), [["msg_sch_owned_1", mapping.sessionID], ["msg_restart", mapping.sessionID], ["msg_compact", mapping.sessionID]])
  assert.deepEqual(nativeScheduleCarrierWakes(mapping, 0, window, ids).map(wake => wake.run), [1])
  assert.deepEqual(nativeScheduleCarrierWakes(mapping, 1, window, ids), [])
  for (const projection of [hint("msg_sch_owned_1"), { ...wakeHint(mapping.scheduleID, 1), metadata: { schedule: { run: 999 } } }]) {
    const resolved = await reader.contextMessages(mapping.sessionID, [projection])
    assert.deepEqual(nativeScheduleCarrierWakes(mapping, 0, resolved).map(wake => wake.run), [1])
  }
  const partial = hint(`msg_${mapping.scheduleID}_2`)
  await assert.rejects(reader.contextMessages(mapping.sessionID, [partial]), /coverage/)
})

test("unknown, foreign, incomplete and schedule-bearing native non-wake records fail closed", async t => {
  const f = nativeReads(t), reader = await f.reader()
  f.put("msg_foreign", "synthetic", restart, "ses_foreign")
  f.put("msg_partial", "compaction", { status: "completed" })
  f.put("msg_user", "user", restart)
  for (const id of ["msg_unknown", "msg_foreign", "msg_partial", "msg_user"])
    await assert.rejects(reader.contextMessages(mapping.sessionID, [hint(id)]))
  for (const [id, data] of [["msg_other", { ...restart, metadata: { notice: "other" } }],
    ["msg_schedule", { ...restart, metadata: { notice: "restart", schedule: {} } }]] as const) {
    f.put(id, "synthetic", data)
    const window = await reader.contextMessages(mapping.sessionID, [hint(id)])
    const ids = nativeScheduleCarrierNonWakeMessageIDs(window)
    assert.deepEqual(ids, [])
    assert.throws(() => nativeScheduleCarrierWakes(mapping, 0, window, ids), /carrier-wake/)
  }
})

test("context bounds precede SQL; exact reader shares 128-read/1-MiB budgets and caps each native row before transfer", async t => {
  const f = nativeReads(t), reader = await f.reader()
  await assert.rejects(reader.contextMessages(mapping.sessionID, Array(129).fill(hint("msg_restart"))), /coverage/)
  await assert.rejects(reader.contextMessages(mapping.sessionID, [{ ...hint("msg_restart"), content: "x".repeat(1024 * 1024) }]), /coverage/)
  assert.equal(f.queries.length, 0)
  f.put("msg_oversized", "synthetic", { ...restart, text: "x".repeat(262144) })
  await assert.rejects(reader.contextMessages(mapping.sessionID, [hint("msg_oversized")]), /coverage/)
  assert.equal(f.queries[0].bytes, 0)
  for (let n = 0; n < 5; n++) f.put(`msg_large_${n}`, "synthetic", { ...restart, text: "x".repeat(240_000) })
  await assert.rejects(reader.contextMessages(mapping.sessionID, Array.from({ length: 5 }, (_, n) => hint(`msg_large_${n}`))), /coverage/)
  assert.ok(f.queries.reduce((sum, q) => sum + q.bytes, 0) <= 1024 * 1024)
  assert.ok(Number(f.queries.at(-1)!.params[2]) < 100_000)
  for (const q of f.queries) {
    assert.match(q.sql, /WHERE id=\? AND session_id=\?/)
    assert.match(q.sql, /length\(CAST\(data AS BLOB\)\)<=\? LIMIT 1$/)
    assert.ok(q.bytes <= Number(q.params[2]))
  }
  const bounded = nativeReads(t), absent = await bounded.reader(), wake = { ...mapping, run: 1, messageID: "msg_sch_owned_1" }
  for (let n = 0; n < 128; n++) assert.equal(await absent.message(wake), undefined)
  await assert.rejects(absent.contextMessages(mapping.sessionID, [hint("msg_unknown")]), /capacity/)
  assert.equal(bounded.queries.length, 128)
})

test("product and foundation hooks use exact bounded classifications and keep deterministic compaction recovery", async t => {
  for (const kind of ["product", "foundation"] as const) {
    const owner = await ownerFixture(t), doc = await owner.control("play")
    const calendar = doc.calendars.find(item => item.role === "reconciliation")!
    const f = nativeReads(t, owner.directory), hooks = new Map<string, (event: SessionContext) => Effect.Effect<void>>()
    const observed: Record<string, unknown>[] = []
    const ctx = { ...owner.ctx, location: f.location,
      rpc: { register: () => Effect.void }, aisdk: { hook: () => Effect.void }, session: { ...owner.ctx.session,
        context: () => { throw new Error("unbounded-context-forbidden") },
        hook: (name: string, use: (event: SessionContext) => Effect.Effect<void>) => Effect.sync(() => { hooks.set(name, use) }) } } as unknown as Plugin.Context
    await f.run(Effect.scoped(kind === "product" ? registerNativeMissionScheduleCarrierHooks(ctx)
      : registerNativeScheduleCarrierFoundation(ctx, { ...doc.calendarOwner!.installation, observe: event => { observed.push(event) } })))
    for (let n = 0; n < 300; n++) f.put(`msg_old_${n}`, "synthetic", { ...restart, text: "x".repeat(8192) }, calendar.sessionID)
    f.put("msg_restart", "synthetic", restart, calendar.sessionID)
    f.put("msg_compact", "compaction", compact, calendar.sessionID)
    f.put(`msg_${calendar.scheduleID}_1`, "user", nativeWake(calendar.scheduleID, 1), calendar.sessionID)
    const event = (messages: unknown[]) => ({ sessionID: calendar.sessionID, model: NATIVE_SCHEDULE_CARRIER_MODEL,
      messages, tools: {} }) as SessionContext
    const invoke = (messages: unknown[]) => f.run(Effect.scoped(hooks.get("context")!(event(messages))))
    await invoke([hint("msg_restart"), hint(`msg_${calendar.scheduleID}_1`)])
    assert.deepEqual(f.queries.map(q => q.params[0]), ["msg_restart", `msg_${calendar.scheduleID}_1`, ...(kind === "product" ? [`msg_${calendar.scheduleID}_1`] : [])])
    f.queries.length = 0
    await invoke([hint("msg_compact")])
    assert.deepEqual(f.queries.map(q => q.params[0]), kind === "product" ? ["msg_compact", `msg_${calendar.scheduleID}_1`] : ["msg_compact"])
    if (kind === "foundation") assert.ok(observed.some(item => item.kind === "compacted-wake-point-read"
      && (item.result as { state: string }).state === "not-dispatched")) // The fixture has no service registration.
    f.queries.length = 0
    const recoveries = observed.filter(item => item.kind === "compacted-wake-point-read").length
    await invoke([]) // A checkpoint may absorb the wake without retaining a model-facing ID.
    assert.deepEqual(f.queries.map(q => q.params[0]), kind === "product" ? [`msg_${calendar.scheduleID}_1`] : [])
    if (kind === "foundation") assert.equal(observed.filter(item => item.kind === "compacted-wake-point-read").length, recoveries + 1)
    await assert.rejects(invoke([hint("msg_unknown")]), /coverage/)
    await assert.rejects(invoke([hint(`msg_${calendar.scheduleID}_2`)]), /coverage/)
    f.put("msg_sch_foreign_1", "user", nativeWake("sch_foreign", 1), calendar.sessionID)
    await assert.rejects(invoke([wakeHint("sch_foreign", 1)]), /carrier-wake/)
    await assert.rejects(invoke(Array(129).fill(hint("msg_restart"))), /coverage/)
    assert.deepEqual(await owner.read(), doc)
  }
})

test("native schedule correlation, deterministic identity and signal stay strict despite a valid projected copy", async t => {
  const f = nativeReads(t)
  const valid = nativeWake(mapping.scheduleID, 1), id = "msg_sch_owned_1"
  for (const data of [
    { ...valid, text: "forged wake prose" }, { ...valid, metadata: {} },
    { ...valid, metadata: { schedule: { ...valid.metadata.schedule, id: "sch_foreign" } } },
    { ...valid, metadata: { schedule: { ...valid.metadata.schedule, run: 2 } } },
    { ...valid, metadata: { schedule: { ...valid.metadata.schedule, dueAt: -1 } } },
    { ...valid, metadata: { schedule: { ...valid.metadata.schedule, late: "false" } } },
  ]) {
    f.put(id, "user", data)
    const reader = await f.reader()
    await assert.rejects(async () => nativeScheduleCarrierWakes(mapping, 0,
      await reader.contextMessages(mapping.sessionID, [wakeHint(mapping.scheduleID, 1)])), /carrier-wake|wake-identity/)
  }
  f.put(id, "assistant", { content: [] })
  await assert.rejects((await f.reader()).contextMessages(mapping.sessionID, [hint(id)]), /carrier-wake/)
  await assert.rejects((await f.reader()).contextMessages(mapping.sessionID, [{ role: "user" }]), /coverage/)
})

test("an attempted auxiliary resolves its schedule ID from native records, retaining its unacknowledged mapping", async t => {
  const owner = await ownerFixture(t)
  owner.loseCreateACK("reconciliation")
  const doc = await owner.control("play")
  const descriptor = doc.calendarOwner!.slots.find(item => item.role === "reconciliation")!
  assert.equal(descriptor.creation, "attempted")
  assert.equal(descriptor.scheduleID, null)
  const calendar = [...owner.calendars.values()][0]
  const f = nativeReads(t, owner.directory), id = `msg_${calendar.id}_1`
  f.put(id, "user", nativeWake(calendar.id, 1), descriptor.sessionID)
  const ctx = { ...owner.ctx, location: f.location } as Plugin.Context
  await f.run(nativeMissionScheduleWakeContext(ctx, { sessionID: descriptor.sessionID, model: NATIVE_SCHEDULE_CARRIER_MODEL,
    messages: [hint(id)], tools: {} } as unknown as SessionContext))
  assert.deepEqual(f.queries.map(query => query.params.slice(0, 2)), [[id, descriptor.sessionID], [id, descriptor.sessionID]])
  assert.deepEqual(await owner.read(), doc) // No service registration: no native adoption or dispatch.
})
