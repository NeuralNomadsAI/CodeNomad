import type { Plugin } from "@opencode/plugin"
import { historyQuerySchema, pruneBatchSchema, type HistoryNativeResult } from "./history-contract"
import { queryHistoryPage } from "./history-store"
import { withHistoryDatabase } from "./history-database"
import { pruneBoundMessage } from "./service"
import type { PruneResult } from "./contract"

export async function queryBoundHistory(ctx: Plugin.Context, value: unknown, signal: AbortSignal): Promise<HistoryNativeResult> {
  const input = historyQuerySchema.parse(value)
  return withHistoryDatabase(ctx, input.sessionID, signal, (db, scope) => queryHistoryPage(db, scope, input, signal))
}

export async function pruneBoundBatch(ctx: Plugin.Context, value: unknown, signal: AbortSignal,
  notify: (sessionID: string, result: Extract<PruneResult, { status: "pruned" }>) => Promise<void>) {
  const input = pruneBatchSchema.parse(value)
  const results: Array<{ messageID: string; result: PruneResult }> = []
  for (const candidate of input.candidates) {
    signal.throwIfAborted()
    let result: PruneResult
    try {
      result = await pruneBoundMessage(ctx, { sessionID: input.sessionID, messageID: candidate.messageID,
        revision: candidate.revision }, signal, true)
    } catch { result = { status: "blocked", reason: "unavailable" } }
    if (result.status === "pruned") await notify(input.sessionID, result).catch(() => {})
    results.push({ messageID: candidate.messageID, result })
  }
  return { results }
}
