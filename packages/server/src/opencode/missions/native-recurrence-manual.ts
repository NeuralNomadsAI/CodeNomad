import type { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Schema } from "effect"
import { recurrenceManualRequestSchema, recurrenceManualResultSchema } from "../../missions/recurrence-manual-rpc"
import { assertRecurrenceBridgeProof, nativeRecurrenceControlInputSchema } from "./native-recurrence-control"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { nativeRecurrenceDue } from "./native-recurrence-due"
import { startNativeRecurrenceSettlement } from "./native-recurrence-settle-job"
import { readNativeRecurrenceClock } from "./native-service-clock"
import type { RecurrencePassage } from "../../missions/recurrence-contract"

type NativeContext = Pick<Plugin.Context, "storage" | "location">
export const readNativeRecurrenceRunNow = Effect.fn("missions.readNativeRecurrenceRunNow")(function* (ctx: NativeContext, raw: unknown) {
  const input = recurrenceManualRequestSchema.parse(raw), store = yield* acquireNativeRecurrenceStore(ctx)
  const doc = yield* Effect.promise(() => store.read(input.scheduleID))
  if (!doc || !doc.config.roots.some(root => root.directory === ctx.location.directory)) throw new Error("Recurrence scope changed")
  const exact = (passage: RecurrencePassage) =>
    passage.due.kind === "manual" && passage.due.requestID === input.requestID && passage.due.expectedRevision === input.expectedRevision
  const pending = doc.pending && exact(doc.pending.passage) ? doc.pending : null
  const archived = doc.history.find(item => exact(item.passage))
  const passage = pending?.passage ?? archived?.passage
  return recurrenceManualResultSchema.parse({ ...input, version: 1, projectID: doc.projectID, projectCanonical: doc.projectCanonical,
    location: { directory: ctx.location.directory, ...(ctx.location.workspaceID === undefined ? {} : { workspaceID: ctx.location.workspaceID }) },
    outcome: archived ? "settled" : pending?.admission ? "accepted" : "unknown", passageID: passage?.id ?? null,
    messageID: passage?.messageID ?? null, admission: pending?.admission ?? null })
})

/** Only this original authenticated call can reserve/start; status never dispatches. */
export const runNativeRecurrenceNow = Effect.fn("missions.runNativeRecurrenceNow")(function* (ctx: NativeContext, raw: unknown) {
  const input = yield* Schema.decodeUnknownEffect(nativeRecurrenceControlInputSchema)(raw)
  const request = recurrenceManualRequestSchema.parse({ scheduleID: input.scheduleID, requestID: input.requestID, expectedRevision: input.expectedRevision })
  if (input.action !== "run-now" || input.retry || input.location.directory !== ctx.location.directory
    || input.location.workspaceID !== ctx.location.workspaceID) throw new Error("Recurrence manual scope changed")
  yield* Effect.tryPromise(() => assertRecurrenceBridgeProof(input))
  const store = yield* acquireNativeRecurrenceStore(ctx), before = yield* Effect.promise(() => store.read(input.scheduleID))
  if (!before || !before.config.roots.some(root => root.directory === ctx.location.directory)) throw new Error("Recurrence scope changed")
  if (before.controls.some(item => item.requestID === input.requestID)) return yield* readNativeRecurrenceRunNow(ctx, request)
  const doc = yield* Effect.promise(() => store.reserveManual(input.scheduleID, input.requestID, input.expectedRevision,
    Date.now(), input.profileSource, () => true))
  const placement = { projectID: doc.projectID, projectCanonical: doc.projectCanonical,
    directory: ctx.location.directory, workspaceID: ctx.location.workspaceID, scheduleID: doc.id,
    profileID: doc.config.profileID, executionHost: doc.config.executionHost }
  const due = nativeRecurrenceDue(ctx, { ...placement, profileSource: doc.profileSource,
    manual: { requestID: input.requestID, expectedRevision: input.expectedRevision } })
  const controller = new AbortController()
  // A failed first attempt stays pending under its original identity; the observer retries it.
  yield* due(doc.id, () => true, controller.signal).pipe(Effect.catchCause(() => Effect.succeed("pending")),
    Effect.ensuring(Effect.sync(() => controller.abort())))
  // A live running schedule Job observes the passage. Otherwise (paused, or
  // Interrupted after a restart) start the settlement-only observer; it reconciles
  // but never starts daily work. An unknown read is not proof of absence while the
  // schedule is desired running: starting then could put a second observer beside
  // its live daily Job. If that Job is in fact gone the schedule shows Interrupted,
  // and Resume reconciles the pending passage.
  const after = yield* Effect.promise(() => store.read(doc.id))
  if (after?.pending?.passage.id === doc.pending!.passage.id) {
    const live = yield* readNativeRecurrenceClock(placement).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    if (live === false || (live === undefined && after.state !== "running"))
      yield* startNativeRecurrenceSettlement(ctx, placement, after)
  }
  const result = yield* readNativeRecurrenceRunNow(ctx, request)
  if (result.outcome !== "unknown") {
    const fresh = yield* Effect.promise(() => store.read(doc.id))
    const control = fresh!.controls.find(item => item.requestID === input.requestID)!
    yield* Effect.promise(() => store.recordControl(doc.id, { ...control, controlsComplete: true }, () => true))
  }
  return result
})
