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
  const message = async (wake: NativeScheduleWake) => {
    current(); assertNativeScheduleWake(wake)
    const data = await run(client!.unsafe("SELECT type,data FROM session_message WHERE id=? AND session_id=? AND length(CAST(data AS BLOB))<=262144",
      [wake.messageID, wake.sessionID]).withoutTransform.pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows))))
    current()
    if (data.length !== 1 || data[0].type !== "user" || typeof data[0].data !== "string") return undefined
    const user = Schema.decodeUnknownSync(SessionMessage.User)({ ...JSON.parse(data[0].data), id: wake.messageID, type: "user" })
    const metadata = user.metadata?.schedule as { id?: unknown; run?: unknown; dueAt?: unknown; late?: unknown } | undefined
    if (user.text !== NATIVE_SCHEDULE_CARRIER_SIGNAL || metadata?.id !== wake.scheduleID || metadata.run !== wake.run
      || !Number.isSafeInteger(metadata.dueAt) || Number(metadata.dueAt) < 0 || typeof metadata.late !== "boolean") return undefined
    return { scheduleID: wake.scheduleID, run: wake.run, messageID: wake.messageID, dueAt: Number(metadata.dueAt) }
  }
  return { current, message }
})
export type NativeMissionScheduleWakeReader = Effect.Success<ReturnType<typeof acquireNativeMissionScheduleWakeReader>>
