import { Context, Effect, Option, Predicate } from "effect"
import { acquireMissionNativeService } from "./native-service-adapter"

/** Read-only qualification of the actual service graph consumed by the reviewed
 * due callback. No timers, Job starts, keys or database writes on discovery. */
export const qualifyNativeRecurrenceControl = Effect.fn("missions.qualifyRecurrenceControl")(function* () {
  yield* Effect.scoped(acquireMissionNativeService())
  const job = yield* Effect.serviceOption(Context.Service<never, unknown>("@opencode/Job"))
  const locations = yield* Effect.serviceOption(Context.Service<never, unknown>("@opencode/example/LocationServiceMap"))
  const database = yield* Effect.serviceOption(Context.Service<never, unknown>("@opencode/storage/Database"))
  const session = yield* Effect.serviceOption(Context.Service<never, unknown>("@opencode/Session"))
  if (Option.isNone(job) || Option.isNone(locations) || Option.isNone(database) || Option.isNone(session)) throw new Error("Native recurrence graph unavailable")
  const controls = session.value as Record<string, unknown>
  const jobs = job.value as Record<string, unknown>, map = locations.value as Record<string, unknown>
  const db = (database.value as { db?: { $client?: { unsafe?: unknown; transactionService?: unknown }; transaction?: unknown } }).db
  if (![jobs.get, jobs.start, jobs.cancel, map.contextEffect, map.contextEffectOption, db?.transaction, db?.$client?.unsafe,
    controls.interrupt, controls.cancelInbox].every(Predicate.isFunction)
    || !Context.isKey(db?.$client?.transactionService)) throw new Error("Native recurrence graph unavailable")
  return true as const
})
