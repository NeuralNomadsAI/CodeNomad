import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client"
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

type Payload = { sessionID?: unknown; assistantMessageID?: unknown; id?: unknown; ordinal?: unknown }
type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>

function assistantOf(data: Data, event: OpenCodeEvent): { payload: Payload; messageId?: string; row?: Assistant } {
  const payload = event.data as Payload
  if (typeof payload.sessionID !== "string" || typeof payload.assistantMessageID !== "string") return { payload }
  const row = data.session.message.get(payload.sessionID, payload.assistantMessageID)
  return { payload, messageId: payload.assistantMessageID, row: row?.type === "assistant" ? row : undefined }
}

const partKind = (type: string) =>
  TEXT_EVENTS.has(type) ? "text" : REASONING_EVENTS.has(type) ? "reasoning" : TOOL_EVENTS.has(type) ? "tool" : undefined

/** Evaluated before the event reduces: the divergence key (message, part kind
 * and tool ID) when the reducer lacks the message, or the part, the event edits. */
export function missingEventTarget(data: Data, event: OpenCodeEvent): string | undefined {
  const part = partKind(event.type)
  if (!part && !ASSISTANT_EVENTS.has(event.type)) return undefined
  const { payload, messageId, row } = assistantOf(data, event)
  if (messageId === undefined) return undefined
  const key = `${messageId}\0${part ?? ""}\0${part === "tool" ? String(payload.id) : ""}`
  if (!row) return key
  const held = part === undefined || row.content.some((item) => {
    if (part === "text") return item.type === "text"
    if (part === "reasoning") return item.type === "reasoning" && !item.time?.completed
    return item.type === "tool" && item.id === payload.id
  })
  return held ? undefined : key
}

/** Whether a page now holds what a missed event targeted: its message and, for
 * part events, a part of that kind (the tool by ID). */
export function holdsEventTarget(data: Data, event: OpenCodeEvent): boolean {
  const part = partKind(event.type)
  const { payload, row } = assistantOf(data, event)
  if (!row) return false
  if (part === "tool") return row.content.some((item) => item.type === "tool" && item.id === payload.id)
  if (part === "text" || part === "reasoning") return row.content.some((item) => item.type === part)
  return true
}

/** A fragment event an authoritative page already reflects. Native ordinals
 * count a step's text and reasoning fragments separately from 0, one fragment
 * of each kind open at a time, and tool IDs are unique per step; a step only
 * restarts on the same message before producing output. So a start whose
 * ordinal (or tool ID) the row already holds, or a delta/ending for a fragment
 * a later one already follows, is a delivery behind the page: the SDK would
 * append a duplicate part or edit the latest one. Events without an ordinal
 * apply as before. */
export function isRedeliveredFragment(data: Data, event: OpenCodeEvent): boolean {
  const type = event.type
  const text = type.startsWith("session.text.")
  const reasoning = type.startsWith("session.reasoning.")
  if (!text && !reasoning && type !== "session.tool.input.started") return false
  const { payload, row } = assistantOf(data, event)
  if (!row) return false
  if (type === "session.tool.input.started") return row.content.some((item) => item.type === "tool" && item.id === payload.id)
  if (typeof payload.ordinal !== "number") return false
  const kind = text ? "text" : "reasoning"
  const count = row.content.filter((item) => item.type === kind).length
  return type.endsWith(".started") ? count > payload.ordinal : count > payload.ordinal + 1
}

/** One reducer's divergence: the targets live events missed while it lacked
 * them (keyed by message, part kind and tool ID; `undefined` for a reducer
 * failure), and its repair budget. A replaced reducer or a new execution
 * starts a new record. */
export type TranscriptDivergence = {
  entry: object
  targets: Map<string, OpenCodeEvent | undefined>
  repairs: number
  pending: boolean
  /** A settlement observed during a pending repair owes one more read. */
  settlementOwed: boolean
}

export function divergenceFor(holder: { divergence?: TranscriptDivergence }, entry: object): TranscriptDivergence {
  if (holder.divergence?.entry !== entry) {
    holder.divergence = { entry, targets: new Map(), repairs: 0, pending: false, settlementOwed: false }
  }
  return holder.divergence
}

export function isDiverged(holder: { divergence?: TranscriptDivergence }, entry: object): boolean {
  return holder.divergence?.entry === entry && holder.divergence.targets.size > 0
}

/** After an authoritative page reseeded the reducer: settle the targets it
 * now holds (and a reducer failure); the rest stay owed. */
export function settleHeldTargets(divergence: TranscriptDivergence | undefined, data: Data): void {
  if (!divergence) return
  for (const [key, event] of divergence.targets) {
    if (!event || holdsEventTarget(data, event)) divergence.targets.delete(key)
  }
}
