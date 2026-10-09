import { Context, Effect, Option, Predicate, Schema } from "effect"
import path from "node:path"
import type { SqlClient } from "effect/unstable/sql"
import { Form } from "@opencode/schema/form"
import { Permission } from "@opencode/schema/permission"
import { Shell } from "@opencode/schema/shell"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { RECURRENCE_STORAGE_PREFIX, parseRecurrenceDocument, recurrenceDispatchAllowed, type RecurrenceDocument } from "../../missions/recurrence-contract"
import { stableToken } from "../../missions/journal"

const tag = (name: string) => Context.Service<never, unknown>(name)
const databaseTag = tag("@opencode/storage/Database"), locationTag = tag("@opencode/Location")
// `@opencode/SessionExecution` is not exposed to plugin or Location contexts (2.0.26); the
// native Session service re-exports its `active` Effect as the set of running session IDs.
const sessionTag = tag("@opencode/Session"), formTag = tag("@opencode/Form")
const permissionTag = tag("@opencode/Permission"), shellTag = tag("@opencode/Shell")
type NativeEffect = Effect.Effect<unknown, unknown>
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const runningToolsSQL = `SELECT count(*) AS count FROM session_message, json_each(session_message.data,'$.content') AS part
  WHERE session_id=? AND session_message.type='assistant' AND json_extract(part.value,'$.type')='tool'
  AND json_extract(part.value,'$.state.status') IN ('running','streaming')`
export type PassageSessionObservation = {
  id: string; parentID?: string; projectID: string; directory: string; workspaceID?: string
  active: boolean; inbox: number; pending: number; suspended: boolean; runningTools: number
  failed: boolean; messagePresent: boolean
}
export interface NativePassageObservation {
  assertCurrent(): true
  /** Synchronous fence only for native admission, which runs outside a SQL transaction. */
  assertScheduleCurrent(document: RecurrenceDocument, dispatch: boolean): true
  exists(sessionID: string): Promise<boolean>
  session(sessionID: string, messageID?: string): Promise<PassageSessionObservation>
  children(sessionID: string): Promise<string[]>
  requests(sessionIDs: readonly string[]): Promise<boolean>
}

/** Read-only native contracts, not signed authority or event replay. Unknown
 * coverage fails closed. SQL only observes durable inbox/claim and ancestry. */
export const acquireNativePassageObservation = Effect.fn("missions.acquirePassageObservation")(function* () {
  const graph = yield* Effect.context<never>()
  const get = (key: typeof databaseTag) => {
    const value = Context.getOption(graph, key)
    if (Option.isNone(value)) throw new Error("Native passage observation unavailable")
    return value.value
  }
  const database = get(databaseTag) as { db?: { $client?: SqlClient.SqlClient } }
  const location = get(locationTag), sessions = get(sessionTag) as { active?: unknown }
  const forms = get(formTag) as { list(): NativeEffect }, permissions = get(permissionTag) as { list(): NativeEffect }
  const shells = get(shellTag) as { list(): NativeEffect }
  if (!Predicate.isFunction(database.db?.$client?.unsafe) || !Effect.isEffect(sessions.active)
    || !Predicate.isFunction(forms.list) || !Predicate.isFunction(permissions.list) || !Predicate.isFunction(shells.list))
    throw new Error("Native passage contracts unavailable")
  const query = (sql: string, params: readonly unknown[]) => Effect.runPromise(database.db!.$client!.unsafe(sql, params)
    .withoutTransform.pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows)), Effect.provide(graph)))
  const run = (effect: NativeEffect) => Effect.runPromise(effect.pipe(Effect.provide(graph)))
  const activeSet = (value: unknown): ReadonlySet<unknown> => {
    if (!(value instanceof Set) || value.size > 4096) throw new Error("Native execution coverage unavailable")
    return value
  }
  const running = sessions.active as NativeEffect
  const sync = (sql: string, params: readonly unknown[]) => Effect.runSync(database.db!.$client!.unsafe(sql, params)
    .withoutTransform.pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows)), Effect.provide(graph)))
  const assertCurrent = (): true => {
    if (Context.get(graph, databaseTag) !== database || Context.get(graph, locationTag) !== location)
      throw new Error("Native passage Location changed")
    return true
  }
  return {
    assertCurrent,
    assertScheduleCurrent: (document: RecurrenceDocument, dispatch: boolean): true => {
      assertCurrent()
      const key = `${RECURRENCE_STORAGE_PREFIX}/project/${stableToken(`${document.projectID}\0${document.projectCanonical}`, 24)}/${document.id}`
      const prefix = `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
      const raw = sync("SELECT value FROM kv WHERE key=?", [`${prefix}${key}`])[0]?.value
      if (typeof raw !== "string") throw new Error("Passage schedule unavailable")
      const fresh = parseRecurrenceDocument(JSON.parse(raw), document.projectID, document.projectCanonical, document.id)
      if (fresh.pending?.passage.id !== document.pending?.passage.id || !samePassageObservation(fresh.config, document.config)
        || dispatch && !recurrenceDispatchAllowed(fresh)) throw new Error("Passage schedule changed")
      return true
    },
    exists: async (id: string) => { assertCurrent(); return (await query("SELECT id FROM session_v2 WHERE id=?", [id])).length === 1 },
    session: async (id: string, messageID?: string): Promise<PassageSessionObservation> => {
      assertCurrent()
      const session = (await query("SELECT id,parent_id,project_id,directory,workspace_id,time_suspended FROM session_v2 WHERE id=?", [id]))[0]
      if (!session || session.id !== id || typeof session.project_id !== "string" || typeof session.directory !== "string")
        throw new Error("Native passage session unavailable")
      const count = async (sql: string, params: readonly unknown[]) => {
        const value = (await query(sql, params))[0]?.count
        if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Native passage coverage unavailable")
        return Number(value)
      }
      const inbox = await count("SELECT count(*) AS count FROM session_inbox WHERE session_id=?", [id])
      const pending = await count("SELECT count(*) AS count FROM session_pending WHERE session_id=?", [id])
      const runningTools = await count(runningToolsSQL, [id])
      const active = activeSet(await run(running)).has(id)
      const terminal = (await query("SELECT type FROM event WHERE aggregate_id=? AND type IN ('session.execution.failed.1','session.execution.succeeded.1','session.execution.interrupted.1') ORDER BY seq DESC LIMIT 1", [id]))[0]
      const messagePresent = messageID !== undefined && ((await query("SELECT id FROM session_message WHERE session_id=? AND id=?", [id, messageID])).length === 1
        || (await query("SELECT id FROM session_inbox WHERE session_id=? AND id=?", [id, messageID])).length === 1)
      assertCurrent()
      // Native SQL stores slash-separated Windows paths; the Location graph uses host separators.
      return { id, projectID: session.project_id, directory: path.normalize(session.directory),
        ...(session.parent_id == null ? {} : { parentID: String(session.parent_id) }),
        ...(session.workspace_id == null ? {} : { workspaceID: String(session.workspace_id) }),
        active, inbox, pending, suspended: session.time_suspended != null, runningTools,
        failed: terminal?.type === "session.execution.failed.1", messagePresent }
    },
    children: async (id: string) => {
      assertCurrent()
      const children = await query("SELECT id FROM session_v2 WHERE parent_id=? ORDER BY id LIMIT 33", [id])
      if (children.length > 32 || children.some(row => typeof row.id !== "string")) throw new Error("Native passage family capacity")
      return children.map(row => row.id as string)
    },
    requests: async (sessionIDs: readonly string[]) => {
      const read = async (operation: NativeEffect, codec: Schema.Codec<unknown, unknown>) => {
        const value = await run(operation)
        Schema.decodeUnknownSync(codec)(value)
        if (!Array.isArray(value) || value.length > 1024 || value.some(item => !item || typeof item !== "object"))
          throw new Error("Native passage request coverage unavailable")
        return value as Record<string, unknown>[]
      }
      const [pendingForms, pendingPermissions, runningShells] = await Promise.all([
        read(forms.list(), Schema.Array(Schema.toType(Form.Info)).check(Schema.isMaxLength(1024))),
        read(permissions.list(), Schema.Array(Schema.toType(Permission.Request)).check(Schema.isMaxLength(1024))),
        read(shells.list(), Schema.Array(Schema.toType(Shell.Info)).check(Schema.isMaxLength(1024)))])
      assertCurrent()
      // Sessionless pending Forms and uncorrelated running Shells cannot be
      // safely attributed away. Native shell list returns running records only.
      return [...pendingForms, ...pendingPermissions].some(item => item.sessionID == null || sessionIDs.includes(String(item.sessionID)))
        || runningShells.some(item => item.status === "running")
    },
  } satisfies NativePassageObservation
})

export const samePassageObservation = (a: unknown, b: unknown) => canonicalAuthority(a) === canonicalAuthority(b)
