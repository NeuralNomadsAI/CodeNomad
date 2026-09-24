import { serverApi } from "../lib/api-client"
import { tGlobal } from "../lib/i18n"
import type { HistoryCandidate, HistoryPage, HistoryQuery } from "../../../server/src/opencode/session-pruning/history-contract"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { refreshSessionContent } from "./session-pruning-events"

export async function readHistoryPage(instanceId: string, input: HistoryQuery, signal?: AbortSignal): Promise<HistoryPage> {
  signal?.throwIfAborted()
  const result = await serverApi.querySessionHistory(instanceId, input, signal)
  signal?.throwIfAborted()
  if (result.status !== "page") throw new Error(tGlobal(`session.pruning.${result.reason}`))
  return result
}

export async function walkHistory(instanceId: string, input: HistoryQuery, visit: (page: HistoryPage) => void, signal?: AbortSignal) {
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const page = await readHistoryPage(instanceId, { ...input, cursor }, signal)
    visit(page)
    cursor = page.cursor ?? undefined
    if (cursor && seen.has(cursor)) throw new Error(tGlobal("session.pruning.conflict"))
    if (cursor) seen.add(cursor)
  } while (cursor)
}

export async function findHistoryMatches(instanceId: string, input: HistoryQuery, signal: AbortSignal): Promise<HistoryPage> {
  const seen = new Set<string>()
  let cursor = input.cursor
  let skipped = 0
  for (;;) {
    const page = await readHistoryPage(instanceId, { ...input, cursor }, signal)
    skipped += page.skipped
    if (page.hits.length || !page.cursor) return { ...page, skipped }
    if (seen.has(page.cursor)) throw new Error(tGlobal("session.pruning.conflict"))
    seen.add(page.cursor)
    cursor = page.cursor
  }
}

export interface SessionTechnicalPartDeletionPlan {
  instanceId: string
  sessionId: string
  generation: number
  toolCount: number
  reasoningCount: number
  candidates: HistoryCandidate[]
  skipped: number
}

export async function planSessionTechnicalPartDeletion(instanceId: string, sessionId: string,
  options?: { signal?: AbortSignal; progress?: (messages: number) => void }): Promise<SessionTechnicalPartDeletionPlan> {
  const plan: SessionTechnicalPartDeletionPlan = { instanceId, sessionId, generation: getOpenCodeInstanceGeneration(instanceId), toolCount: 0, reasoningCount: 0, candidates: [], skipped: 0 }
  let scanned = 0
  await walkHistory(instanceId, { sessionID: sessionId, purpose: "prune", query: "", includeTechnical: true }, page => {
    if (plan.generation !== getOpenCodeInstanceGeneration(instanceId)) throw new Error(tGlobal("session.pruning.conflict"))
    // Compact IDs/revisions only: no message content or transcript-store writes.
    plan.candidates.push(...page.candidates)
    plan.toolCount += page.candidates.reduce((n, c) => n + c.toolCount, 0)
    plan.reasoningCount += page.candidates.reduce((n, c) => n + c.reasoningCount, 0)
    plan.skipped += page.skipped
    scanned += page.scanned
    options?.progress?.(scanned)
  }, options?.signal)
  return plan
}

export async function executeSessionTechnicalPartDeletion(plan: SessionTechnicalPartDeletionPlan,
  options?: { signal?: AbortSignal; progress?: (completed: number, total: number) => void }): Promise<string[]> {
  const failures: string[] = []
  try {
    for (let offset = 0; offset < plan.candidates.length; offset += 16) {
      options?.signal?.throwIfAborted()
      if (plan.generation !== getOpenCodeInstanceGeneration(plan.instanceId)) throw new Error(tGlobal("session.pruning.conflict"))
      const candidates = plan.candidates.slice(offset, offset + 16)
      const response = await serverApi.pruneSessionHistory(plan.instanceId, { sessionID: plan.sessionId, candidates }, options?.signal)
      if (plan.generation !== getOpenCodeInstanceGeneration(plan.instanceId)) throw new Error(tGlobal("session.pruning.conflict"))
      for (const entry of response.results) {
        if (entry.result.status === "blocked") failures.push(tGlobal(`session.pruning.${entry.result.reason}`))
      }
      options?.progress?.(Math.min(offset + 16, plan.candidates.length), plan.candidates.length)
    }
    return failures
  } finally {
    // Also invalidate after an ambiguous timeout/cancellation. Never fetch every
    // pruned message back into the UI: the ordinary active window reconciles.
    if (plan.generation === getOpenCodeInstanceGeneration(plan.instanceId)) {
      refreshSessionContent(plan.instanceId, plan.sessionId)
    }
  }
}
