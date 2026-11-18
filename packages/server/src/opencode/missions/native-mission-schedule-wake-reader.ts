import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { SessionMessage } from "@opencode/schema/session-message"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import type { NativeMissionDocumentRunner } from "./native-mission-document-storage"
import type { NativeScheduleWake } from "./native-schedule-transport-contract"
import { assertNativeScheduleWake } from "./native-schedule-transport-contract"
import { NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"

const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
const locationTag = Context.Service<never, unknown>("@opencode/Location")
const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))

/** Context hooks have Database/Location but no private Session/Schedule. Every
 * reader belongs to this invocation; native schedule ACKs are checked in RPC. */
export const acquireNativeMissionScheduleWakeReader = Effect.fn("missions.acquireScheduleWakeReader")(function* (
  ctx: Plugin.Context, run: NativeMissionDocumentRunner,
) {
  const found = yield* Effect.serviceOption(databaseTag), source = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(found) || Option.isNone(source)) throw new Error("schedule-wake-reader-unavailable")
  const client = (found.value as { db?: { $client?: SqlClient.SqlClient } }).db?.$client
  if (!Predicate.isFunction(client?.unsafe)) throw new Error("schedule-wake-reader-unavailable")
  const location = Schema.decodeUnknownSync(Schema.toType(Schema.Struct(Location.Info.fields)))(source.value)
  let active = true
  yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
  const current = (): true => {
    if (!active || location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
      || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical)
      throw new Error("schedule-wake-reader-retired")
    return true
  }
  // Context classification cannot spend the nine deterministic recovery reads.
  // SQL applies both byte ceilings before returning any native message body.
  const classification = { reads: 0, bytes: 0, limit: 128 }, recovery = { reads: 0, bytes: 0, limit: 9 }
  const resolved = new Map<string, unknown>()
  const key = (sessionID: string, messageID: string) => JSON.stringify([sessionID, messageID])
  const read = async (sessionID: string, messageID: string, budget = recovery) => {
    current()
    if (++budget.reads > budget.limit) throw new Error("schedule-wake-reader-coverage")
    const maximum = Math.min(262144, 1024 * 1024 - budget.bytes)
    const data = await run(client!.unsafe("SELECT type,CASE WHEN length(CAST(data AS BLOB))<=262144 AND length(CAST(data AS BLOB))<=? THEN data END AS data FROM session_message WHERE id=? AND session_id=? LIMIT 1",
      [maximum, messageID, sessionID]).withoutTransform.pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows))))
    current()
    if (!data.length) return undefined
    if (data.length !== 1 || typeof data[0].data !== "string" || Buffer.byteLength(data[0].data) > maximum)
      throw new Error("schedule-wake-reader-coverage")
    budget.bytes += Buffer.byteLength(data[0].data)
    return { ...JSON.parse(data[0].data), id: messageID, type: data[0].type }
  }
  const message = async (wake: NativeScheduleWake) => {
    assertNativeScheduleWake(wake)
    current()
    const data = resolved.get(key(wake.sessionID, wake.messageID)) ?? await read(wake.sessionID, wake.messageID)
    if (!data || (data as { type?: unknown }).type !== "user") return undefined
    const user = Schema.decodeUnknownSync(SessionMessage.User)(data)
    const metadata = user.metadata?.schedule as { id?: unknown; run?: unknown; dueAt?: unknown; late?: unknown } | undefined
    if (user.text !== NATIVE_SCHEDULE_CARRIER_SIGNAL || metadata?.id !== wake.scheduleID || metadata.run !== wake.run
      || !Number.isSafeInteger(metadata.dueAt) || Number(metadata.dueAt) < 0 || typeof metadata.late !== "boolean") return undefined
    return { scheduleID: wake.scheduleID, run: wake.run, messageID: wake.messageID, dueAt: Number(metadata.dueAt) }
  }
  // The LLM projection supplies IDs only. Resolve every user-role entry against
  // its native row, including wakes; projected metadata and prose carry no proof.
  const contextMessages = async (sessionID: string, messages: readonly unknown[]) => {
    current()
    if (messages.length > 128 || Buffer.byteLength(JSON.stringify(messages)) > 1024 * 1024) throw new Error("schedule-carrier-coverage")
    const ids = new Set<string>()
    for (const raw of messages) {
      if (!raw || typeof raw !== "object") throw new Error("schedule-carrier-context")
      const hint = raw as { role?: unknown; id?: unknown }
      if (hint.role !== "user") continue
      if (typeof hint.id !== "string" || !hint.id.length || hint.id.length > 1024) throw new Error("schedule-carrier-coverage")
      ids.add(hint.id)
    }
    const result = []
    for (const id of ids) {
      const data = await read(sessionID, id, classification)
      if (!data) throw new Error("schedule-carrier-coverage")
      if (data.type === "user") {
        const user = Schema.decodeUnknownSync(SessionMessage.User)(data)
        if (user.text !== NATIVE_SCHEDULE_CARRIER_SIGNAL) throw new Error("schedule-carrier-wake")
        result.push(user)
      }
      else if (data.type === "synthetic") result.push(Schema.decodeUnknownSync(SessionMessage.Synthetic)(data))
      else if (data.type === "compaction") result.push(Schema.decodeUnknownSync(SessionMessage.Compaction)(data))
      else throw new Error("schedule-carrier-wake")
      resolved.set(key(sessionID, id), data)
    }
    return result
  }
  return { current, message, contextMessages }
})
export type NativeMissionScheduleWakeReader = Effect.Success<ReturnType<typeof acquireNativeMissionScheduleWakeReader>>
