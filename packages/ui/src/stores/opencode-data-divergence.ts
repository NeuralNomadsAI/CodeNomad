import type { OpenCodeEvent } from "@opencode/client"
import type { Data } from "@opencode/client/solid"

/** Live events the SDK reducer applies only to an assistant message it already
 * holds; the part-level ones also need their text, reasoning or tool part.
 * Anything else silently drops the event. */
const ASSISTANT_EVENTS = new Set([
  "session.step.ended",
  "session.step.failed",
  "session.text.started",
  "session.reasoning.started",
  "session.tool.input.started",
])
const TEXT_EVENTS = new Set(["session.text.delta", "session.text.ended"])
const REASONING_EVENTS = new Set(["session.reasoning.delta", "session.reasoning.ended"])
const TOOL_EVENTS = new Set([
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
])

/** Repair reads one reducer may owe its watched session per execution; the
 * settlement read of a still-diverged transcript is owed beyond it. */
export const MAX_DIVERGENCE_REPAIRS = 3

/** Evaluated before the event reduces: the assistant message ID when the
 * reducer lacks the message (or the part) the event edits. */
export function missingEventTarget(data: Data, event: OpenCodeEvent): string | undefined {
  const type = event.type
  const part = TEXT_EVENTS.has(type) ? "text" : REASONING_EVENTS.has(type) ? "reasoning" : TOOL_EVENTS.has(type) ? "tool" : undefined
  if (!part && !ASSISTANT_EVENTS.has(type)) return undefined
  const payload = event.data as { sessionID?: unknown; assistantMessageID?: unknown; id?: unknown }
  if (typeof payload.sessionID !== "string" || typeof payload.assistantMessageID !== "string") return undefined
  const row = data.session.message.get(payload.sessionID, payload.assistantMessageID)
  if (row?.type !== "assistant") return payload.assistantMessageID
  const held = part === undefined || row.content.some((item) => {
    if (part === "text") return item.type === "text"
    if (part === "reasoning") return item.type === "reasoning" && !item.time?.completed
    return item.type === "tool" && item.id === payload.id
  })
  return held ? undefined : payload.assistantMessageID
}

/** One reducer's divergence: the assistant messages live events targeted
 * while it lacked them, and its repair budget. A replaced reducer, a new
 * execution or a seeded page starts a new record. */
export type TranscriptDivergence = {
  entry: object
  targets: Set<string>
  repairs: number
  pending: boolean
  /** A settlement observed during a pending repair owes one more read. */
  settlementOwed: boolean
}

export function divergenceFor(holder: { divergence?: TranscriptDivergence }, entry: object): TranscriptDivergence {
  if (holder.divergence?.entry !== entry) {
    holder.divergence = { entry, targets: new Set(), repairs: 0, pending: false, settlementOwed: false }
  }
  return holder.divergence
}

export function isDiverged(holder: { divergence?: TranscriptDivergence }, entry: object): boolean {
  return holder.divergence?.entry === entry && holder.divergence.targets.size > 0
}
