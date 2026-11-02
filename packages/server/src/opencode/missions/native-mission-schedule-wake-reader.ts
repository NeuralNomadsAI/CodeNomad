import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { SessionMessage } from "@opencode/schema/session-message"
import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import type { NativeMissionDocumentRunner } from "./native-mission-document-storage"
import type { NativeScheduleWake } from "./native-schedule-transport-contract"
import { assertNativeScheduleWake } from "./native-schedule-transport-contract"
import { NATIVE_SCHEDULE_CARRIER_SIGNAL } from "./native-schedule-carrier-binding"
import type { NativeScheduleCarrierMapping } from "./native-schedule-carrier"

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
  // Shared by classification and original-message proofs in this invocation.
  // SQL applies both byte ceilings before returning any native message body.
  let reads = 0, bytes = 0
  const read = async (sessionID: string, messageID: string) => {
    current()
    if (++reads > 128) throw new Error("schedule-wake-reader-capacity")
    const maximum = Math.min(262144, 1024 * 1024 - bytes)
    const data = await run(client!.unsafe("SELECT type,data FROM session_message WHERE id=? AND session_id=? AND length(CAST(data AS BLOB))<=262144 AND length(CAST(data AS BLOB))<=? LIMIT 1",
      [messageID, sessionID, maximum]).withoutTransform.pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows))))
    current()
    if (!data.length) return undefined
    if (data.length !== 1 || typeof data[0].data !== "string" || Buffer.byteLength(data[0].data) > maximum)
      throw new Error("schedule-wake-reader-coverage")
    bytes += Buffer.byteLength(data[0].data)
    return { ...JSON.parse(data[0].data), id: messageID, type: data[0].type }
  }
  const message = async (wake: NativeScheduleWake) => {
    assertNativeScheduleWake(wake)
    const data = await read(wake.sessionID, wake.messageID)
    if (data?.type !== "user") return undefined
    const user = Schema.decodeUnknownSync(SessionMessage.User)(data)
    const metadata = user.metadata?.schedule as { id?: unknown; run?: unknown; dueAt?: unknown; late?: unknown } | undefined
    if (user.text !== NATIVE_SCHEDULE_CARRIER_SIGNAL || metadata?.id !== wake.scheduleID || metadata.run !== wake.run
      || !Number.isSafeInteger(metadata.dueAt) || Number(metadata.dueAt) < 0 || typeof metadata.late !== "boolean") return undefined
    return { scheduleID: wake.scheduleID, run: wake.run, messageID: wake.messageID, dueAt: Number(metadata.dueAt) }
  }
  // Model-context IDs select exact native records; their prose never classifies
  // a notice/checkpoint. Current deterministic wakes keep strict hint validation.
  const nonWakeMessages = async (mapping: NativeScheduleCarrierMapping, messages: readonly unknown[]) => {
    current()
    if (messages.length > 128 || Buffer.byteLength(JSON.stringify(messages)) > 1024 * 1024) throw new Error("schedule-carrier-coverage")
    const ids = new Set<string>()
    for (const raw of messages) {
      if (!raw || typeof raw !== "object") throw new Error("schedule-carrier-context")
      const hint = raw as { role?: unknown; id?: unknown; metadata?: { schedule?: unknown } }
      if (hint.role !== "user" || hint.metadata?.schedule !== undefined) continue
      if (typeof hint.id !== "string" || !hint.id.length || hint.id.length > 1024) throw new Error("schedule-carrier-coverage")
      if (!hint.id.startsWith(`msg_${mapping.scheduleID}_`)) ids.add(hint.id)
    }
    const result: Array<typeof SessionMessage.Synthetic.Type | typeof SessionMessage.Compaction.Type> = []
    for (const id of ids) {
      const data = await read(mapping.sessionID, id)
      if (!data) throw new Error("schedule-carrier-coverage")
      if (data.type === "synthetic") result.push(Schema.decodeUnknownSync(SessionMessage.Synthetic)(data))
      else if (data.type === "compaction") result.push(Schema.decodeUnknownSync(SessionMessage.Compaction)(data))
      else throw new Error("schedule-carrier-wake")
    }
    return result
  }
  return { current, message, nonWakeMessages }
})
export type NativeMissionScheduleWakeReader = Effect.Success<ReturnType<typeof acquireNativeMissionScheduleWakeReader>>
