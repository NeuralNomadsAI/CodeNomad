import { Context, Effect, Option, Predicate, Schema } from "effect"
import { createHash } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { SessionMessage } from "@opencode/schema/session-message"
import { Shell } from "@opencode/schema/shell"
import type { SqlClient } from "effect/sql"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { stableToken } from "../../missions/receipt-identity"
import { nativePassageMessageDigest } from "./native-service-adapter"
import { nativeMessageDataSQL } from "./native-message-data"
import path from "node:path"
import type { NativeMissionSession } from "../../missions/control-types"
import { matchesExecution, parseExecution } from "../../missions/execution"
import { coordinatorBaselineSchema, COORDINATOR_INPUT_MARKER, type CoordinatorBaseline } from "../../missions/mission-coordinator-baseline"

const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const transactionGraph = new AsyncLocalStorage<Context.Context<never>>()
export class ScheduledCoordinatorRefusal extends Error {
  constructor(readonly reason: "coordinator-busy" | "coordinator-owned" | "coordinator-is-source") { super(reason) }
}
export const withNativeSourceTransaction = <A>(graph: Context.Context<never>, use: () => A): A => transactionGraph.run(graph, use)
export const readNativeSourceRows = (client: SqlClient.SqlClient, graph: Context.Context<never>, sql: string, args: readonly unknown[]) =>
  Effect.runSync(client.unsafe(sql, args).withoutTransform.pipe(Effect.provide(transactionGraph.getStore() ?? graph)))
const nativeKey = (key: string) => `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:${key}`
export const nativeBackgroundSQL = `SELECT key,json_extract(value,'$.recovery.kind') AS kind,
  json_extract(value,'$.recovery.sessionID') AS sessionID,json_extract(value,'$.recovery.parentSessionID') AS parentSessionID,
  json_extract(value,'$.recovery.childSessionID') AS childSessionID
  FROM kv WHERE key>='job.background/' AND key<'job.background0' ORDER BY key LIMIT 1025`
export function assertNativeBackgroundRows(rows: readonly Record<string, unknown>[]) {
  if (rows.length > 1024 || rows.some(item => item.kind === "subagent"
    ? typeof item.parentSessionID !== "string" || typeof item.childSessionID !== "string"
    : !["shell", "image"].includes(String(item.kind)) || typeof item.sessionID !== "string"))
    throw new Error("Native passage background coverage unavailable")
}

export function nativeShellBlocksFamily(item: { status?: unknown; metadata?: unknown }, ids: ReadonlySet<string>): boolean {
  if (item.status !== "running") return false
  const metadata = item.metadata
  const owner = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).sessionID : undefined
  return typeof owner !== "string" || !owner.trim() || ids.has(owner)
}

/** Exact read-only source projections, checked again synchronously in the target
 * document transaction. No lease or native asynchronous effect enters that CAS. */
export const acquireNativeSourceFence = Effect.fn("missions.acquireSourceFence")(function* (alive: () => true) {
  const found = yield* Effect.serviceOption(databaseTag)
  const database = Option.isSome(found) ? found.value as { db?: { $client?: SqlClient.SqlClient } } : undefined
  if (!Predicate.isFunction(database?.db?.$client?.unsafe)) throw new Error("Mission source database unavailable")
  const graph = yield* Effect.context<never>()
  const shellService = Context.getOption(graph, Context.Service<never, unknown>("@opencode/Shell"))
  const read = (sql: string, args: readonly unknown[]) => {
    alive()
    const result = readNativeSourceRows(database.db!.$client!, graph, sql, args)
    if (!Array.isArray(result)) throw new Error("Mission source projection unavailable")
    return result as Record<string, unknown>[]
  }
  // Match the ordinary range reader's boundaries, including stray project keys.
  // Rehash inside the existing synchronous transaction fence, including malformed
  // values and original JSON spelling; timestamps and event counts are not proof.
  const journalDigest = (prefix: string) => {
    const start = nativeKey(prefix)
    const end = start.slice(0, -1) + String.fromCharCode(start.charCodeAt(start.length - 1) + 1)
    const hash = createHash("sha256")
    let after = start, inclusive = true
    for (;;) {
      const page = read(`SELECT key,value FROM kv WHERE key${inclusive ? ">=" : ">"}? AND key<? ORDER BY key LIMIT 32`, [after, end])
      for (const { key, value } of page) {
        if (typeof key !== "string" || typeof value !== "string" || !key.startsWith(start) || key === after && !inclusive)
          throw new Error("Mission source journal projection unavailable")
        hash.update(`${key.length}:${key}${value.length}:`, "utf16le").update(value, "utf16le")
        after = key
        inclusive = false
      }
      if (page.length < 32) return hash.digest("base64url")
    }
  }
  return () => {
    const proofs: { sql: string; args: readonly unknown[]; digest: string }[] = []
    const checks: Array<() => void> = []
    let bytes = 0
    const pin = (sql: string, args: readonly unknown[]) => {
      const result = read(sql, args), encoded = canonicalAuthority(result, 16 * 1024 * 1024)
      bytes += Buffer.byteLength(encoded)
      if (bytes > 16 * 1024 * 1024 || proofs.length >= 4096) throw new Error("Mission source proof capacity")
      proofs.push({ sql, args, digest: stableToken(encoded, 64) })
      return result
    }
    return {
      absentSession: (id: string) => {
        if (pin("SELECT id FROM session_v2 WHERE id=?", [id]).length) throw new Error("Selected native session exists")
      },
      selectedSession: (session: Pick<NativeMissionSession, "id" | "parentID" | "projectID" | "location"> & { metadata?: unknown }) => {
        const result = pin("SELECT id,parent_id,project_id,directory,workspace_id,metadata FROM session_v2 WHERE id=?", [session.id])
        const row = result[0]
        if (result.length !== 1 || row.id !== session.id || (row.parent_id ?? undefined) !== session.parentID || row.project_id !== session.projectID
          || typeof row.directory !== "string" || path.normalize(row.directory) !== path.normalize(session.location.directory)
          || (row.workspace_id ?? undefined) !== session.location.workspaceID
          || canonicalAuthority(row.metadata == null ? null : JSON.parse(String(row.metadata))) !== canonicalAuthority(session.metadata ?? null))
          throw new Error("Selected native session changed")
      },
      preparedSession: (session: NativeMissionSession) => {
        const rows = pin(`SELECT id,parent_id,project_id,directory,workspace_id,metadata,revert,time_suspended,agent,model,title,
          EXISTS(SELECT 1 FROM session_message WHERE session_id=s.id) AS messages,
          EXISTS(SELECT 1 FROM session_inbox WHERE session_id=s.id) AS inbox,
          EXISTS(SELECT 1 FROM session_v2 WHERE parent_id=s.id) AS children FROM session_v2 s WHERE id=?`, [session.id])
        const row = rows[0]
        if (rows.length !== 1 || row.id !== session.id || row.parent_id != null || row.project_id !== session.projectID
          || typeof row.directory !== "string" || path.normalize(row.directory) !== path.normalize(session.location.directory)
          || (row.workspace_id ?? undefined) !== session.location.workspaceID || row.time_suspended != null || row.revert != null
          || row.messages !== 0 || row.inbox !== 0 || row.children !== 0 || row.title !== session.title
          || (row.agent ?? undefined) !== session.agent
          || canonicalAuthority(row.metadata == null ? null : JSON.parse(String(row.metadata))) !== canonicalAuthority(session.metadata ?? null)
          || (row.model == null ? !!session.model : !session.model || !matchesExecution(parseExecution({ model: JSON.parse(String(row.model)) }), session)))
          throw new Error("Prepared coordinator is not empty or its selection changed")
      },
      document: (key: string) => { pin("SELECT value FROM kv WHERE key=? AND length(value)<=262144", [nativeKey(key)]) },
      journal: (prefix: string, exceptKey?: string, ordinary = false) => {
        if (ordinary && exceptKey === undefined) {
          const digest = journalDigest(prefix)
          checks.push(() => { if (journalDigest(prefix) !== digest) throw new Error("Mission source changed during preparation") })
          return
        }
        const start = nativeKey(prefix), end = `${start}\uffff`
        const args = [start, end, exceptKey === undefined ? "" : nativeKey(exceptKey)]
        const size = read("SELECT count(*) AS count,coalesce(sum(length(value)),0) AS size FROM kv WHERE key>=? AND key<? AND key<>?", args)[0]
        if (!size || !Number.isSafeInteger(size.count) || Number(size.count) > 2036 || !Number.isSafeInteger(size.size)
          || Number(size.size) > 16 * 1024 * 1024) throw new Error("Mission source journal capacity")
        pin("SELECT key,value FROM kv WHERE key>=? AND key<? AND key<>? ORDER BY key LIMIT 2037", args)
      },
      // Pins the chosen family for ownership; an active conversation queues the passage prompt natively.
      coordinator: (id: string) => {
        const cte = `WITH RECURSIVE family(id) AS (SELECT id FROM session_v2 WHERE id=? UNION SELECT s.id FROM session_v2 s JOIN family f ON s.parent_id=f.id LIMIT 4097)`
        const members = pin(`${cte} SELECT s.id,s.parent_id,s.project_id,s.directory,s.workspace_id,s.metadata,s.agent,s.model
          FROM session_v2 s JOIN family f ON s.id=f.id ORDER BY s.id`, [id])
        if (!members.length || members.length > 4096) throw new ScheduledCoordinatorRefusal("coordinator-owned")
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
      family: (id: string, messageID?: string, captureBaseline = false, inherited?: CoordinatorBaseline) => {
        const background = captureBaseline ? read(nativeBackgroundSQL, []) : []
        if (captureBaseline) assertNativeBackgroundRows(background)
        const awaiting = new Set(background.map(item => String(item.kind === "subagent" ? item.parentSessionID : item.sessionID)))
        if (captureBaseline && Option.isSome(shellService)) {
          const shells = shellService.value as { list?(): Effect.Effect<unknown, unknown> }
          const projection = () => {
            if (!Predicate.isFunction(shells.list)) throw new Error("Native background shell coverage unavailable")
            const value = shells.list()
            if (!Effect.isEffect(value)) throw new Error("Native background shell coverage unavailable")
            const items = Schema.decodeUnknownSync(Schema.Array(Schema.toType(Shell.Info)).check(Schema.isMaxLength(1024)))(Effect.runSync(value.pipe(Effect.provide(graph))))
            return items.filter(item => item.status === "running").map(item => ({ id: item.id,
              sessionID: typeof item.metadata.sessionID === "string" ? item.metadata.sessionID : null })).sort((a, b) => a.id.localeCompare(b.id))
          }
          for (const shell of projection()) if (shell.sessionID) awaiting.add(shell.sessionID)
        }
        const cte = `WITH RECURSIVE family(id) AS (SELECT id FROM session_v2 WHERE id=? UNION SELECT s.id FROM session_v2 s JOIN family f ON s.parent_id=f.id LIMIT 4097)`
        const ids = read(`${cte} SELECT id FROM family`, [id])
        if (ids.length > 4096) throw new Error("Mission source family capacity")
        // Admission captures an active family's baseline as observed: its ongoing turn keeps
        // writing, and the passage prompt queues behind it. Settlement still pins everything.
        const observe = captureBaseline ? read : pin
        const baseline = observe(`${cte} SELECT s.id,s.parent_id,s.project_id,s.directory,s.workspace_id,s.time_suspended,
          (SELECT count(*) FROM session_inbox i WHERE i.session_id=s.id) AS inbox,
          (SELECT max(seq) FROM session_message m WHERE m.session_id=s.id) AS seq${inherited ? `,s.metadata,
          (SELECT json_object('id',m.id,'seq',m.seq,'type',m.type,'data',m.data) FROM session_message m
            WHERE m.session_id=s.id AND m.id=json_extract(s.metadata,'$."${COORDINATOR_INPUT_MARKER}".messageID')) AS passage_input` : ""}${captureBaseline ? `,
          (SELECT seq FROM event_sequence e WHERE e.aggregate_id=s.id) AS aggregate_seq,
          (SELECT id FROM session_message m WHERE m.session_id=s.id ORDER BY seq DESC LIMIT 1) AS boundary,
          (SELECT type FROM session_message m WHERE m.session_id=s.id ORDER BY seq DESC LIMIT 1) AS last_type,
          (SELECT id FROM session_message m WHERE m.session_id=s.id AND m.type IN ('user','synthetic') ORDER BY seq DESC LIMIT 1) AS input,
          (SELECT id FROM session_inbox i WHERE i.session_id=s.id AND i.type IN ('user','synthetic') ORDER BY enqueued_seq LIMIT 1) AS queued_input` : ""}
          FROM session_v2 s JOIN family f ON f.id=s.id ORDER BY s.id`, [id])
        if (captureBaseline) {
          const parents = new Map(baseline.map(row => [String(row.id), row.parent_id]))
          for (const row of baseline) if (row.time_suspended != null || Number(row.inbox) > 0 || row.last_type !== "idle" && row.input != null)
            awaiting.add(String(row.id))
          // Idle ancestors can receive a later native background notice. Their
          // existing input is the exact inherited entry for that owned work.
          for (const sessionID of awaiting) {
            const parent = parents.get(sessionID)
            if (typeof parent === "string") awaiting.add(parent)
          }
        }
        // The latest seq alone survives pruning or rewriting the original input.
        // Pin the exact correlation used by H11, including empty projections.
        observe(`${cte} SELECT s.id,
          (SELECT json_object('id',m.id,'seq',m.seq,'type',m.type,'data',m.data) FROM session_message m
            WHERE m.session_id=s.id AND CASE WHEN s.id=? AND ? IS NOT NULL THEN m.id=?
              ELSE m.type IN ('user','synthetic') END ORDER BY m.seq ASC LIMIT 1) AS origin,
          (SELECT json_object('id',m.id,'seq',m.seq,'type',m.type,'data',m.data) FROM session_message m
            WHERE m.session_id=s.id ORDER BY m.seq DESC LIMIT 1) AS terminal
          FROM session_v2 s JOIN family f ON f.id=s.id ORDER BY s.id`, [id, id, messageID ?? null, messageID ?? null])
        if (inherited) pin(`SELECT json_extract(b.value,'$[0]') AS id,
          (SELECT json_object('id',m.id,'seq',m.seq,'type',m.type,'data',m.data) FROM session_message m
            WHERE m.session_id=json_extract(b.value,'$[0]') AND m.id=(SELECT json_extract(s.metadata,'$."${COORDINATOR_INPUT_MARKER}".messageID')
              FROM session_v2 s WHERE s.id=m.session_id)) AS current_input,
          (SELECT json_object('id',m.id,'seq',m.seq,'type',m.type,'data',m.data) FROM session_message m
            WHERE m.session_id=json_extract(b.value,'$[0]') AND m.id=json_extract(b.value,'$[2]')) AS boundary,
          (SELECT json_object('id',m.id,'seq',m.seq,'type',m.type,'data',m.data) FROM session_message m
            WHERE m.session_id=json_extract(b.value,'$[0]') AND m.id=json_extract(b.value,'$[3]')) AS inherited_input,
          (SELECT seq FROM event_sequence e WHERE e.aggregate_id=json_extract(b.value,'$[0]')) AS aggregate_seq,
          (SELECT metadata FROM session_v2 s WHERE s.id=json_extract(b.value,'$[0]')) AS metadata,
          (SELECT count(*) FROM session_message m WHERE m.session_id=json_extract(b.value,'$[0]')
            AND m.seq>json_extract(b.value,'$[1]') AND m.type='idle' AND json_extract(m.data,'$.outcome')='failed') AS failures
          FROM json_each(?) b ORDER BY id`, [canonicalAuthority(inherited, 256 * 1024)])
        return captureBaseline ? coordinatorBaselineSchema.parse(baseline.map(row => [row.id, row.seq ?? -1, row.boundary ?? null,
          row.last_type !== "idle" || Number(row.inbox) > 0 || awaiting.has(String(row.id)) ? row.input ?? row.queued_input ?? null : null,
          row.aggregate_seq])) : []
      },
      current: (): true => {
        alive()
        for (const check of checks) check()
        for (const proof of proofs) if (stableToken(canonicalAuthority(read(proof.sql, proof.args), 16 * 1024 * 1024), 64) !== proof.digest)
          throw new Error("Mission source changed during preparation")
        return true
      },
    }
  }
})
type SourceFence = ReturnType<Effect.Success<ReturnType<typeof acquireNativeSourceFence>>>
export type NativeSourceFence = Omit<SourceFence, "preparedSession" | "selectedSession" | "absentSession" | "coordinator">
  & Partial<Pick<SourceFence, "coordinator" | "absentSession">>
