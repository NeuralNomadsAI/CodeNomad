import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import Ajv from "ajv"
import { Context, Effect } from "effect"
import { MissionCreationIntents } from "../../missions/creation-intent"
import type { MissionStorage } from "../../missions/journal"
import type { MissionJsonValue } from "../../missions/model"
import { resolveMissionCreationDefaults } from "../../missions/profile-defaults"
import { stableToken } from "../../missions/receipt-identity"
import { missionScheduleRpcMethods, type MissionScheduleRequest } from "../../missions/mission-schedule-contract"
import { nativeMissionScheduleHandlers } from "./native-mission-schedule-rpc"
import { nativeMissionScheduleAgentCreationVerifier } from "./native-mission-schedule-authority"
import { withNativeSourceTransaction } from "./native-source-fence"

async function fixture(t: test.TestContext) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close())
  db.exec("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT)")
  const project = { id: "project", canonical: "/owned" }, values = new Map<string, MissionJsonValue>()
  const nativeKey = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value) => {
      values.set(key, structuredClone(value))
      db.prepare("INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(nativeKey(key), JSON.stringify(value))
    },
    scan: async ({ prefix, after, limit = 100 }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)
      && (after === undefined || key > after)).slice(0, limit).map(([key, value]) => ({ key, value })) }),
  }
  const intents = new MissionCreationIntents(storage, stableToken(`${project.id}\0${project.canonical}`, 24))
  const input = { objective: "Prepare", template: "custom" as const }
  const defaults = { request: {}, ...resolveMissionCreationDefaults({ ...input, preferences: [] }) }
  const binding = { author: { coordinatorSessionID: "ses_author", missionID: "source_mission" },
    creationRequestID: "original", creationDigest: "c".repeat(64) }
  const intentID = `msn_${stableToken(`${project.id}\0${binding.creationRequestID}`, 24)}`
  await intents.save(intentID, input, defaults, async () => undefined, () => {}, "prepare-conflict")
  await intents.bind(intentID, binding)
  let gets = 0, needsTransaction = false
  const transaction = Context.Service<never, boolean>("preparation-test-transaction")
  const database = Context.Service<never, unknown>("@opencode/storage/Database")
  const sql = { unsafe: (query: string, args: readonly unknown[]) => ({ withoutTransform: Effect.gen(function* () {
    if (needsTransaction) assert.equal(yield* transaction, true)
    return db.prepare(query).all(...args as []).map(row => ({ ...row }))
  }) }) }
  const graph = Context.make(database, { db: { $client: sql } })
  const ctx = { location: { directory: "/owned", project }, storage: {
    get: (key: string) => Effect.sync(() => { gets++; return structuredClone(values.get(key)) }),
  } }
  const run = Effect.runPromiseWith(graph)
  const request = { action: "create", transport: { principal: { kind: "agent", ...binding } } } as MissionScheduleRequest
  return { db, values, storage, binding, ctx, graph, request, run, nativeKey, gets: () => gets,
    transactionGuard: (current: () => true) => {
      needsTransaction = true
      try { return withNativeSourceTransaction(Context.add(graph, transaction, true), current) }
      finally { needsTransaction = false }
    } }
}

test("production preparation RPC reads exactly one durable intent and never writes", async t => {
  const f = await fixture(t), handlers = nativeMissionScheduleHandlers(f.ctx as never)
  const before = structuredClone([...f.values]), input = { creationRequestID: "original" }
  const result = await f.run(handlers.schedulePreparationRead(input))
  assert.deepEqual(result, { binding: f.binding }); assert.equal(f.gets(), 1)
  const wire = new Ajv().compile(missionScheduleRpcMethods.schedulePreparationRead.output)
  assert.equal(wire(result), true, JSON.stringify(wire.errors))
  assert.deepEqual(await f.run(handlers.schedulePreparationRead({ creationRequestID: "missing" })), {})
  await assert.rejects(f.run(handlers.schedulePreparationRead({ ...input, projectID: "foreign" })))
  assert.equal(f.gets(), 2); assert.deepEqual([...f.values], before)
})

test("native CREATE binding is exact and its raw durable bytes stay fenced inside document CAS", async t => {
  const f = await fixture(t), verify = nativeMissionScheduleAgentCreationVerifier(f.ctx as never, f.run)
  const current = await f.run(verify(f.request))
  assert.equal(f.transactionGuard(current), true)
  const wrong = structuredClone(f.request)
  if (wrong.transport.principal?.kind === "agent") wrong.transport.principal.creationDigest = "d".repeat(64)
  await assert.rejects(f.run(verify(wrong)), /binding differs/)
  const key = [...f.values.keys()][0]
  f.db.prepare("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify({ changed: true }), f.nativeKey(key))
  assert.throws(() => f.transactionGuard(current), /changed during preparation/)
  f.db.prepare("DELETE FROM kv WHERE key=?").run(f.nativeKey(key))
  assert.throws(() => f.transactionGuard(current), /changed during preparation/)
  f.values.delete(key)
  await assert.rejects(f.run(verify(f.request)))
})
