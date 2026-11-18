// Qualification observer only: no model/session hooks, provider override or
// Mission mutation. Kept separate so a missing runtime is genuinely unloaded.
import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Clock, Context, Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { nativeScheduleDocumentKey } from "./native-schedule-carrier-binding"

const method = { input: { type: "object" }, output: { type: "object" } } as const
const definition = Rpc.define({ id: "codenomad.schedule-clock-qualification", methods: { tick: method, snapshot: method }, events: {} })
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const nativePrefix = `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`

export default Plugin.define({ id: "codenomad.schedule-clock-qualification", effect: ctx => Effect.gen(function* () {
  yield* ctx.rpc.register(definition, {
    tick: raw => Effect.gen(function* () {
      const at = (raw as { at: number }).at
      if (!Number.isSafeInteger(at) || at < 0) throw new Error("qualification-clock")
      const native = yield* Effect.serviceOption(Context.Service<never, unknown>("@opencode/Schedule"))
      if (Option.isNone(native)) throw new Error("qualification-schedule-contract")
      const tick = (native.value as { tick: Effect.Effect<void, unknown> }).tick
      if (!Effect.isEffect(tick)) throw new Error("qualification-schedule-contract")
      const real = yield* Clock.Clock
      const controlled: Clock.Clock = {
        currentTimeMillisUnsafe: () => at, currentTimeMillis: Effect.succeed(at),
        currentTimeNanosUnsafe: () => BigInt(at) * 1_000_000n, currentTimeNanos: Effect.succeed(BigInt(at) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(), monotonicTimeNanos: real.monotonicTimeNanos,
        sleep: duration => real.sleep(duration),
      }
      yield* tick.pipe(Effect.provideService(Clock.Clock, controlled))
      return { at, clock: "native Effect Clock on this tick only; OS clock unchanged" }
    }).pipe(Effect.orDie),
    snapshot: raw => Effect.gen(function* () {
      const input = raw as { sessionID: string; scheduleID: string }
      const found = yield* Effect.serviceOption(Context.Service<never, unknown>("@opencode/storage/Database"))
      if (Option.isNone(found)) throw new Error("qualification-database-contract")
      const client = (found.value as { db: { $client: SqlClient.SqlClient } }).db.$client
      const query = (sql: string, params: readonly unknown[]) => client.unsafe(sql, params).withoutTransform.pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows)))
      const schedule = (yield* query("SELECT id,session_id,status,\"when\",next_due_at,ends_at,remaining_runs,run_count,last_outcome,time_created,time_updated FROM schedule WHERE id=?", [input.scheduleID]))[0]
      const session = (yield* query("SELECT id,title,model,metadata FROM session_v2 WHERE id=?", [input.sessionID]))[0]
      const messages = yield* query(`SELECT id,type,seq,length(CAST(data AS BLOB)) AS bytes,
        json_extract(data,'$.reason') AS reason,json_extract(data,'$.status') AS status,
        json_extract(data,'$.outcome') AS outcome,json_extract(data,'$.error.message') AS error,
        json_extract(data,'$.tokens.input') AS inputTokens,json_extract(data,'$.model') AS model
        FROM session_message WHERE session_id=? ORDER BY seq DESC LIMIT 64`, [input.sessionID])
      const document = (yield* query("SELECT value FROM kv WHERE key=?", [`${nativePrefix}${nativeScheduleDocumentKey(ctx, "native_foundation")}`]))[0]?.value
      if (!schedule || !session || typeof document !== "string") throw new Error("qualification-owned-row")
      return { session, schedule, messages, document: JSON.parse(document) }
    }).pipe(Effect.orDie),
  }).pipe(Effect.orDie)
}) })
