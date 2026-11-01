import type { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import { documentID, MISSION_DOCUMENT_MAX_BYTES } from "../../missions/launch-policy"
import { MISSION_DOCUMENT_PREFIX, MISSION_TOMBSTONE_MAX_BYTES, missionTombstoneSchema, parseMissionDocument,
  parseMissionTombstoneRegistry } from "../../missions/mission-document"
import { NativeMissionDocumentStore, type MissionDocumentStorage } from "../../missions/mission-document-store"
import { stableToken } from "../../missions/receipt-identity"
import { withNativeSourceTransaction } from "./native-source-fence"

const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const clientSchema = Schema.declare<SqlClient.SqlClient>((value): value is SqlClient.SqlClient => Predicate.isFunction(value)
  && Predicate.hasProperty(value, "unsafe") && Predicate.isFunction(value.unsafe))
const method = Schema.declare<(...args: never[]) => Effect.Effect<unknown, unknown>>((value): value is (...args: never[]) => Effect.Effect<unknown, unknown> => Predicate.isFunction(value))
const shape = Schema.Struct({ db: Schema.Struct({ $client: clientSchema, transaction: method }) })
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const nativeKey = (key: string) => `plugin:${Array.from("codenomad.missions").map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
type NativeDatabase = { db: { $client: SqlClient.SqlClient;
  transaction<A>(callback: () => Effect.Effect<A, unknown>, config: { behavior: "immediate" }): Effect.Effect<A, unknown> } }
export type NativeMissionDocumentRunner = <A>(effect: Effect.Effect<A, unknown>) => Promise<A>

/** Acquire and use inside the same current RPC Effect graph. No service lookup,
 * native session effect, config activation or scheduling is part of this adapter. */
export const acquireNativeMissionDocumentStore = Effect.fn("missions.acquireNativeMissionDocumentStore")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location">,
  invocationRun?: NativeMissionDocumentRunner,
) {
  const found = yield* Effect.serviceOption(databaseTag)
  if (Option.isNone(found)) return yield* Effect.fail(new Error("Native Mission document database unavailable"))
  yield* Schema.decodeUnknownEffect(shape)(found.value)
  const { db } = found.value as NativeDatabase
  const projectID = ctx.location.project.id, canonical = ctx.location.project.canonical
  const prefix = `${MISSION_DOCUMENT_PREFIX}/project/${stableToken(`${projectID}\0${canonical}`, 24)}`
  const graph = yield* Effect.context<never>()
  const run: NativeMissionDocumentRunner = invocationRun ?? (effect => Effect.runPromise(effect.pipe(Effect.provide(graph))))
  const query = (sql: string, params: readonly unknown[]) => db.$client.unsafe(sql, params).withoutTransform.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(rows)))
  function decode(key: string, value: unknown) {
    if (key === `${prefix}/tombstones`) return parseMissionTombstoneRegistry(value)
    const id = documentID.parse(key.slice(`${prefix}/missions/`.length))
    if (key !== `${prefix}/missions/${id}`) throw new Error("Invalid Mission document key")
    if (value && typeof value === "object" && "deletedAt" in value) {
      const result = missionTombstoneSchema.parse(value)
      if (result.id !== id || result.projectID !== projectID || result.projectCanonical !== canonical) throw new Error("Foreign Mission tombstone")
      return result
    }
    return parseMissionDocument(value, { id, projectID, projectCanonical: canonical })
  }
  const storage: MissionDocumentStorage = {
    get: key => {
      if (key !== `${prefix}/tombstones` && !key.startsWith(`${prefix}/missions/`)) throw new Error("Invalid Mission document key")
      return run(ctx.storage.get(key)) as ReturnType<MissionDocumentStorage["get"]>
    },
    compareAndSet: (key, value, expected, current) => {
      const next = decode(key, value), max = key === `${prefix}/tombstones` ? MISSION_TOMBSTONE_MAX_BYTES : MISSION_DOCUMENT_MAX_BYTES
      const bytes = canonicalAuthority(value, max), databaseKey = nativeKey(key)
      if (next.revision !== (expected === null ? key === `${prefix}/tombstones` ? 1 : 0 : expected + 1)) throw new Error("Mission document revision conflict")
      return run(db.transaction(() => Effect.gen(function* () {
        const transaction = yield* Effect.context<never>()
        const guard = () => withNativeSourceTransaction(transaction, () => assertSynchronousAuthorityGuard(current, "policy-unqualified"))
        guard()
        const previous = (yield* query("SELECT value FROM kv WHERE key=?", [databaseKey]))[0]?.value
        if (expected === null) {
          if (previous !== undefined) throw new Error("Mission document revision conflict")
          guard()
          yield* query("INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,?,?) ON CONFLICT(key) DO NOTHING", [databaseKey, bytes, Date.now(), Date.now()])
        } else {
          if (typeof previous !== "string" || Buffer.byteLength(previous) > max || decode(key, JSON.parse(previous)).revision !== expected)
            throw new Error("Mission document revision conflict")
          guard()
          yield* query("UPDATE kv SET value=?,time_updated=? WHERE key=? AND value=? AND json_extract(value,'$.revision')=?", [bytes, Date.now(), databaseKey, previous, expected])
        }
        if ((yield* query("SELECT value FROM kv WHERE key=?", [databaseKey]))[0]?.value !== bytes) throw new Error("Mission document publication unknown")
        guard()
      }), { behavior: "immediate" }))
    },
  }
  return new NativeMissionDocumentStore(storage, projectID, canonical)
})
