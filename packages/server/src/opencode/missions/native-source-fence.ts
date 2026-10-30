import { Context, Effect, Option, Predicate, Schema } from "effect"
import { AsyncLocalStorage } from "node:async_hooks"
import { SessionMessage } from "@opencode/schema/session-message"
import type { SqlClient } from "effect/sql"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { stableToken } from "../../missions/receipt-identity"
import { nativePassageMessageDigest } from "./native-service-adapter"
import { nativeMessageDataSQL } from "./native-message-data"

const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const transactionGraph = new AsyncLocalStorage<Context.Context<never>>()
export const withNativeSourceTransaction = <A>(graph: Context.Context<never>, use: () => A): A => transactionGraph.run(graph, use)
const nativeKey = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`

/** Exact read-only source projections, checked again synchronously in the target
 * document transaction. No lease or native asynchronous effect enters that CAS. */
export const acquireNativeSourceFence = Effect.fn("missions.acquireSourceFence")(function* (alive: () => true) {
  const found = yield* Effect.serviceOption(databaseTag)
  const database = Option.isSome(found) ? found.value as { db?: { $client?: SqlClient.SqlClient } } : undefined
  if (!Predicate.isFunction(database?.db?.$client?.unsafe)) throw new Error("Mission source database unavailable")
  const graph = yield* Effect.context<never>()
  const read = (sql: string, args: readonly unknown[]) => {
    alive()
    const result = Effect.runSync(database.db!.$client!.unsafe(sql, args).withoutTransform.pipe(Effect.provide(transactionGraph.getStore() ?? graph)))
    if (!Array.isArray(result)) throw new Error("Mission source projection unavailable")
    return result as Record<string, unknown>[]
  }
  return () => {
    const proofs: { sql: string; args: readonly unknown[]; digest: string }[] = []
    let bytes = 0
    const pin = (sql: string, args: readonly unknown[]) => {
      const result = read(sql, args), encoded = canonicalAuthority(result, 16 * 1024 * 1024)
      bytes += Buffer.byteLength(encoded)
      if (bytes > 16 * 1024 * 1024 || proofs.length >= 4096) throw new Error("Mission source proof capacity")
      proofs.push({ sql, args, digest: stableToken(encoded, 64) })
      return result
    }
    return {
      document: (key: string) => { pin("SELECT value FROM kv WHERE key=? AND length(value)<=262144", [nativeKey(key)]) },
      journal: (prefix: string) => {
        const start = nativeKey(prefix), end = `${start}\uffff`
        const size = read("SELECT count(*) AS count,coalesce(sum(length(value)),0) AS size FROM kv WHERE key>=? AND key<?", [start, end])[0]
        if (!size || !Number.isSafeInteger(size.count) || Number(size.count) > 2036 || !Number.isSafeInteger(size.size)
          || Number(size.size) > 16 * 1024 * 1024) throw new Error("Mission source journal capacity")
        pin("SELECT key,value FROM kv WHERE key>=? AND key<? ORDER BY key LIMIT 2037", [start, end])
      },
      conversation: (id: string) => {
        const rows = pin("SELECT id,parent_id,project_id,directory,workspace_id,metadata,revert,time_suspended FROM session_v2 WHERE id=?", [id])
        if (rows.length !== 1 || rows[0].revert != null) throw new Error("Mission source placement unavailable")
        pin("SELECT id,seq FROM session_message WHERE session_id=? ORDER BY seq DESC LIMIT 1", [id])
      },
      message: (sessionID: string, id: string, digest: string) => {
        const result = pin(`SELECT m.id,m.seq,m.type,${nativeMessageDataSQL} AS data FROM session_message m
          WHERE m.session_id=? AND m.id=? AND length(CAST(${nativeMessageDataSQL} AS BLOB))<=262144`, [sessionID, id])
        const row = result[0]
        if (result.length !== 1 || typeof row.data !== "string" || nativePassageMessageDigest(Schema.decodeUnknownSync(SessionMessage.Info)(
          { ...JSON.parse(row.data), id: row.id, type: row.type })) !== digest) throw new Error("Mission source message changed")
      },
      family: (id: string, messageID?: string) => {
        const cte = `WITH RECURSIVE family(id) AS (SELECT id FROM session_v2 WHERE id=? UNION SELECT s.id FROM session_v2 s JOIN family f ON s.parent_id=f.id LIMIT 4097)`
        const ids = read(`${cte} SELECT id FROM family`, [id])
        if (ids.length > 4096) throw new Error("Mission source family capacity")
        pin(`${cte} SELECT s.id,s.parent_id,s.project_id,s.directory,s.workspace_id,s.time_suspended,
          (SELECT count(*) FROM session_inbox i WHERE i.session_id=s.id) AS inbox,
          (SELECT max(seq) FROM session_message m WHERE m.session_id=s.id) AS seq
          FROM session_v2 s JOIN family f ON f.id=s.id ORDER BY s.id`, [id])
        // The latest seq alone survives pruning or rewriting the original input.
        // Pin the exact correlation used by H11, including empty projections.
        pin(`${cte} SELECT s.id,
          (SELECT json_object('id',m.id,'seq',m.seq,'type',m.type,'data',m.data) FROM session_message m
            WHERE m.session_id=s.id AND CASE WHEN s.id=? AND ? IS NOT NULL THEN m.id=?
              ELSE m.type IN ('user','synthetic') END ORDER BY m.seq ASC LIMIT 1) AS origin,
          (SELECT json_object('id',m.id,'seq',m.seq,'type',m.type,'data',m.data) FROM session_message m
            WHERE m.session_id=s.id ORDER BY m.seq DESC LIMIT 1) AS terminal
          FROM session_v2 s JOIN family f ON f.id=s.id ORDER BY s.id`, [id, id, messageID ?? null, messageID ?? null])
      },
      current: (): true => {
        alive()
        for (const proof of proofs) if (stableToken(canonicalAuthority(read(proof.sql, proof.args), 16 * 1024 * 1024), 64) !== proof.digest)
          throw new Error("Mission source changed during preparation")
        return true
      },
    }
  }
})
export type NativeSourceFence = ReturnType<Effect.Success<ReturnType<typeof acquireNativeSourceFence>>>
