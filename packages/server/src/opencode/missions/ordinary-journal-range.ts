import { Effect, Option } from "effect"
import { acquireNativeJournalRange } from "./native-journal-range"
import type { NativeMissionDocumentRunner } from "./native-mission-document-storage"

/** Fall back only when acquisition is unavailable, never after a range read fails. */
export function optionalOrdinaryJournalRange(ctx: Parameters<typeof acquireNativeJournalRange>[0], run: NativeMissionDocumentRunner) {
  return acquireNativeJournalRange(ctx, run).pipe(Effect.option, Effect.map(Option.getOrUndefined))
}
