import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { authenticateRecurrenceStanding } from "../../missions/recurrence-authority-contract"
import { recurrenceControlRequestSchema, recurrenceControlStatusSchema, type RecurrenceControlStatus } from "../../missions/recurrence-control-contract"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { readSignedRecurrence } from "./native-recurrence-snapshot"

/** One exact schedule and one signed archive read. It never reconciles by
 * resubmitting control, minting a key, changing state or starting a Job. */
export const readNativeRecurrenceControlStatus = Effect.fn("missions.readNativeRecurrenceControlStatus")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location">, raw: unknown,
) {
  const input = recurrenceControlRequestSchema.parse(raw)
  const result: RecurrenceControlStatus = { version: 1, scheduleID: input.scheduleID, requestID: input.requestID,
    expectedRevision: input.expectedRevision, epoch: input.expectedEpoch + 1, outcome: "unknown" }
  const store = yield* acquireNativeRecurrenceStore(ctx)
  const document = yield* Effect.promise(() => store.read(input.scheduleID))
  if (!document || !document.config.roots.some(root => root.directory === ctx.location.directory)) return result
  const authenticated = yield* readSignedRecurrence(ctx, document).pipe(Effect.catchCause(() => Effect.succeed(null)))
  if (!authenticated || authenticated.epoch < result.epoch || document.revision <= input.expectedRevision) return result
  const archived = yield* Effect.promise(() => authenticated.authority.readParent(result.epoch))
  if (!archived) return result
  const body = authenticateRecurrenceStanding(archived, authenticated.signers).signed.body
  if (body.requestID !== input.requestID || body.expectedScheduleRevision !== input.expectedRevision
    || body.action !== (input.action === "play" ? "authorize" : input.action === "pause" ? "pause" : "revoke")) return result
  const rawReceipt = yield* ctx.storage.get(`${authenticated.authority.parentKey}/controls/${result.epoch}`)
  if (!rawReceipt || typeof rawReceipt !== "object" || Array.isArray(rawReceipt)) return result
  const receipt = recurrenceControlStatusSchema.parse({ ...rawReceipt, expectedRevision: input.expectedRevision,
    outcome: "controlsComplete" in rawReceipt && rawReceipt.controlsComplete === true ? "committed" : "unknown" })
  if (receipt.requestID !== input.requestID || receipt.scheduleID !== input.scheduleID || receipt.epoch !== result.epoch
    || receipt.revision !== input.expectedRevision + 1) return result
  return receipt
})
