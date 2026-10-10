import type { Plugin } from "@opencode/plugin/effect"
import type { RecurrenceDocument } from "../../missions/recurrence-contract"
import { nativeRecurrenceDue } from "./native-recurrence-due"
import { startNativeRecurrenceClock, type RecurrenceClockPlacement } from "./native-service-clock"

/** Settlement-only observer for a pending passage without a live schedule Job
 * (paused or Interrupted Run now, Stop, explicit Check). It uses the same
 * sleep/wake seam as the daily Job, never starts a daily passage, may only retry
 * the original start identity while dispatch is allowed, and exits once the
 * passage is settled. Pause cancels it; Stop restarts it for the pending passage. */
export function startNativeRecurrenceSettlement(ctx: Pick<Plugin.Context, "storage" | "location">,
  placement: RecurrenceClockPlacement, doc: RecurrenceDocument) {
  return startNativeRecurrenceClock(placement, nativeRecurrenceDue(ctx, { ...placement, profileSource: doc.profileSource, settleOnly: true }),
    ctx, undefined, "settle")
}
