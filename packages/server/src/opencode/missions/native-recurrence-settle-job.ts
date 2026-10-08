import type { Plugin } from "@opencode/plugin/effect"
import type { RecurrenceDocument } from "../../missions/recurrence-contract"
import { nativeRecurrenceDue } from "./native-recurrence-due"
import { startNativeRecurrenceClock, type RecurrenceClockPlacement } from "./native-service-clock"

/** Settlement-only observer for a paused schedule's pending passage (Run now or
 * explicit Check). It uses the same sleep/wake seam as the daily Job but is
 * reconcile-only: no manual hint, so it never admits a new coordinator message,
 * and it exits once the passage is settled or the schedule leaves paused. */
export function startNativeRecurrenceSettlement(ctx: Pick<Plugin.Context, "storage" | "location">,
  placement: RecurrenceClockPlacement, doc: RecurrenceDocument) {
  return startNativeRecurrenceClock(placement, nativeRecurrenceDue(ctx, { ...placement, profileSource: doc.profileSource }),
    ctx, undefined, "settle")
}
