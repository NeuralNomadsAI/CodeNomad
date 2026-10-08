import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { recurrenceControlRequestSchema, type RecurrenceControlStatus } from "../../missions/recurrence-control-contract"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"

/** Exact request lookup, never a mutation or an automatic resend. */
export const readNativeRecurrenceControlStatus = Effect.fn("missions.readNativeRecurrenceControlStatus")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location">, raw: unknown,
) {
  const input = recurrenceControlRequestSchema.parse(raw)
  const unknown: RecurrenceControlStatus = { version: 1, scheduleID: input.scheduleID, requestID: input.requestID,
    expectedRevision: input.expectedRevision, outcome: "unknown" }
  const store = yield* acquireNativeRecurrenceStore(ctx)
  const doc = yield* Effect.promise(() => store.read(input.scheduleID))
  if (!doc?.config.roots.some(root => root.directory === ctx.location.directory)) return unknown
  const record = doc.controls.find(item => item.requestID === input.requestID)
  if (!record || record.action !== input.action || record.expectedRevision !== input.expectedRevision) return unknown
  const { targetsKnown: _known, ...status } = record
  return { ...unknown, ...status, outcome: record.controlsComplete ? "committed" as const : "unknown" as const }
})
