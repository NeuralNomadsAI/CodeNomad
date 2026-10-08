import type { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import { stableToken } from "../../missions/journal"
import { RECURRENCE_MAX_BYTES, RECURRENCE_SCHEDULE_LIMIT, RECURRENCE_STORAGE_PREFIX, recurrenceIDSchema,
  parseRecurrenceDocument } from "../../missions/recurrence-contract"
import { NativeMissionRecurrenceStore, RecurrenceCreateCapacityError, type RecurrenceStorage } from "../../missions/recurrence-store"
import type { MissionJsonValue } from "../../missions/model"
import { emitNativeRecurrenceChanged } from "./native-recurrence-events"

const pluginID = "codenomad.missions"
const nativeKey = (key: string) => `plugin:${Array.from(pluginID).map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const method = Schema.declare<(...args: never[]) => Effect.Effect<unknown, unknown>>((value): value is (...args: never[]) => Effect.Effect<unknown, unknown> => Predicate.isFunction(value))
const clientSchema = Schema.declare<SqlClient.SqlClient>((value): value is SqlClient.SqlClient => Predicate.isFunction(value)
  && Predicate.hasProperty(value, "unsafe") && Predicate.isFunction(value.unsafe))
const shape = Schema.Struct({ db: Schema.Struct({ $client: clientSchema, transaction: method }) })
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
type NativeDatabase = { db: { $client: SqlClient.SqlClient;
  transaction<A>(callback: () => Effect.Effect<A, unknown>, config: { behavior: "immediate" }): Effect.Effect<A, unknown> } }

/** Acquire inside the native effect plugin's own Location/RPC context. This is
 * metadata CAS, NOT an authorization grant: the signed recurrence authority
 * ledger and fresh admission still decide whether any effect can occur. */
export const acquireNativeRecurrenceStore = Effect.fn("missions.acquireNativeRecurrenceStore")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location">,
) {
  const found = yield* Effect.serviceOption(databaseTag)
  if (Option.isNone(found)) return yield* Effect.fail(new Error("Native recurrence database unavailable"))
  yield* Schema.decodeUnknownEffect(shape)(found.value)
  const { db } = found.value as NativeDatabase
  const projectID = ctx.location.project.id, canonical = ctx.location.project.canonical
  const placement = { projectID, projectCanonical: canonical, directory: ctx.location.directory,
    ...(ctx.location.workspaceID === undefined ? {} : { workspaceID: ctx.location.workspaceID }) }
  const prefix = `${RECURRENCE_STORAGE_PREFIX}/project/${stableToken(`${projectID}\0${canonical}`, 24)}/`
  const databasePrefix = nativeKey(prefix)
  const graph = yield* Effect.context<never>()
  const query = (sql: string, params: readonly unknown[]) => db.$client.unsafe(sql, params).withoutTransform.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(rows)))
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect.pipe(Effect.provide(graph)))
  const storage: RecurrenceStorage = {
    get: key => { checkKey(key); return run(ctx.storage.get(key)) as Promise<MissionJsonValue | undefined> },
    scan: input => { if (input.prefix !== prefix || input.limit !== 16 || input.after !== undefined && !input.after.startsWith(prefix)) {
      throw new Error("Invalid recurrence scan")
    } return run(ctx.storage.scan(input)) as ReturnType<RecurrenceStorage["scan"]> },
    set: async () => { throw new Error("Recurrence requires conditional storage") },
    compareAndSet: (key, value, expected, current) => {
      const id = checkKey(key)
      if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) throw new Error("Recurrence revision conflict")
      const bytes = canonicalAuthority(value, RECURRENCE_MAX_BYTES)
      const next = parseRecurrenceDocument(JSON.parse(bytes), projectID, canonical, id)
      if (next.revision !== (expected === null ? 0 : expected + 1)) throw new Error("Recurrence revision conflict")
      const databaseKey = nativeKey(key)
      return run(db.transaction(() => Effect.gen(function* () {
        const guard = () => assertSynchronousAuthorityGuard(current, "policy-unqualified")
        guard()
        const previous = (yield* query("SELECT value FROM kv WHERE key=?", [databaseKey]))[0]?.value
        if (expected === null) {
          if (previous !== undefined) throw new Error("Recurrence revision conflict")
          const count = (yield* query("SELECT count(*) AS count FROM kv WHERE substr(key,1,?)=?",
            [databasePrefix.length, databasePrefix]))[0]?.count
          if (typeof count !== "number") throw new Error("Recurrence storage capacity unavailable")
          if (count >= RECURRENCE_SCHEDULE_LIMIT) throw new RecurrenceCreateCapacityError()
          guard()
          yield* query("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,?,?) ON CONFLICT(key) DO NOTHING",
            [databaseKey, bytes, Date.now(), Date.now()])
        } else {
          if (typeof previous !== "string" || Buffer.byteLength(previous, "utf8") > RECURRENCE_MAX_BYTES
            || parseRecurrenceDocument(JSON.parse(previous), projectID, canonical, id).revision !== expected) {
            throw new Error("Recurrence revision conflict")
          }
          guard()
          yield* query("UPDATE kv SET value=?,time_updated=? WHERE key=? AND value=? AND json_extract(value,'$.revision')=?",
            [bytes, Date.now(), databaseKey, previous, expected])
        }
        const saved = (yield* query("SELECT value FROM kv WHERE key=?", [databaseKey]))[0]?.value
        if (saved !== bytes) throw new Error("Recurrence publication unknown")
        guard()
      }), { behavior: "immediate" }).pipe(Effect.andThen(
        emitNativeRecurrenceChanged(placement, next.id, next.revision).pipe(
          // Invalidation is volatile display feedback. An emitter failure must
          // not relabel/replay the already committed authoritative calendar CAS.
          Effect.catchCause(() => Effect.logWarning("Committed recurrence invalidation unavailable")),
        ),
      )))
    },
  }
  function checkKey(key: string): string {
    if (!key.startsWith(prefix)) throw new Error("Invalid recurrence key")
    const id = recurrenceIDSchema.parse(key.slice(prefix.length))
    if (`${prefix}${id}` !== key) throw new Error("Invalid recurrence key")
    return id
  }
  return new NativeMissionRecurrenceStore(storage, projectID, canonical)
})
