import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { recurrenceControlRequestSchema, type RecurrenceControlStatus } from "../../missions/recurrence-control-contract"
import type { RecurrenceControlRecord, RecurrenceDocument } from "../../missions/recurrence-contract"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { observeNativeRecurrenceScheduleOnly } from "./native-service-clock"

/** Exact request lookup, never an automatic resend. An unknown Play/Resume whose
 * effect is positively observed (its schedule is still the running intent and its
 * single daily Job runs in this Location) is reconciled in place: the original
 * record completes, no Job is started and no new identity is minted. */
export const readNativeRecurrenceControlStatus = Effect.fn("missions.readNativeRecurrenceControlStatus")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location">, raw: unknown,
) {
  const input = recurrenceControlRequestSchema.parse(raw)
  const unknown: RecurrenceControlStatus = { version: 1, scheduleID: input.scheduleID, requestID: input.requestID,
    expectedRevision: input.expectedRevision, outcome: "unknown" }
  const store = yield* acquireNativeRecurrenceStore(ctx)
  const doc = yield* Effect.promise(() => store.read(input.scheduleID))
  if (!doc?.config.roots.some(root => root.directory === ctx.location.directory)) return unknown
  let record = doc.controls.find(item => item.requestID === input.requestID)
  if (!record || record.action !== input.action || record.expectedRevision !== input.expectedRevision) return unknown
  if (startIntentCurrent(doc, record)) {
    const placement = { projectID: ctx.location.project.id, projectCanonical: ctx.location.project.canonical,
      directory: ctx.location.directory, workspaceID: ctx.location.workspaceID, scheduleID: doc.id,
      profileID: doc.config.profileID, executionHost: doc.config.executionHost }
    // Any failed, partial or foreign Job read stays genuinely unknown (fail closed).
    if (yield* observeNativeRecurrenceScheduleOnly(placement).pipe(Effect.catchCause(() => Effect.succeed(false)))) {
      const observed = record
      const saved = yield* Effect.tryPromise(() => store.recordControl(doc.id,
        { ...observed, controlsComplete: true, targetsKnown: true }, () => true)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      record = saved?.controls.find(item => item.requestID === input.requestID) ?? record
    }
  }
  const { targetsKnown: _known, ...status } = record
  return { ...unknown, ...status, outcome: record.controlsComplete ? "committed" as const : "unknown" as const }
})

/** Only the latest state-changing intent, still running and still incomplete. */
function startIntentCurrent(doc: RecurrenceDocument, record: RecurrenceControlRecord) {
  if (record.controlsComplete || record.action !== "play" && record.action !== "resume"
    || doc.state !== "running" || record.state !== "running") return false
  const latest = doc.controls.filter(item => ["play", "resume", "pause", "stop"].includes(item.action)).at(-1)
  return latest?.requestID === record.requestID
}
