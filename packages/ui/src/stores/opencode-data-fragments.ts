import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client"
import type { Data } from "@opencode/client/solid"
import { fragmentKey, isCommittedFragment } from "./opencode-data-read-merge"

/** How a live event fits the session reducer, evaluated before it reduces.
 *
 * The SDK reducer edits only an assistant message it already holds; text and
 * reasoning events edit that message's latest fragment of their kind, tool
 * events their part by ID. Native ordinals count a step's text and reasoning
 * fragments separately from 0, one fragment of each kind open at a time; tool
 * IDs are unique per step; a step restarts on its message only before it
 * produced output. So against a row holding `count` fragments of the event's
 * kind, a start for ordinal `o` fits when `count === o` and a delta or ending
 * when `count === o + 1`: fewer means the fragment's start was missed (the
 * event would edit an earlier fragment), more means a delivery behind an
 * authoritative page. Events without an ordinal keep the SDK's behavior. */
export type EventFit =
  /** `settles`: a full-text ending that resolves an ambiguity recorded for its fragment. */
  | { kind: "apply"; settles?: string }
  /** Behind the reducer: applying it would duplicate or misplace content. */
  | { kind: "drop" }
  /** The reducer lacks the target; `apply` when reducing it is still harmless.
   * `settlement`: an ambiguity only a lost ending would leave wrong, owed at
   * settlement rather than repaired at once. */
  | { kind: "diverged"; key: string; apply: boolean; settlement?: boolean }

/** Fragments an authoritative page installed: `closed` ones the page holds
 * committed (a delta for them is a redelivery), `partial` ones it holds open
 * with text (a delta is redelivered or new: it cannot be told apart). Keyed by
 * message, kind and ordinal. */
export type PageFragments = Map<string, "closed" | "partial">

const ASSISTANT_EVENTS = new Set(["session.step.ended", "session.step.failed"])
const TOOL_EVENTS = new Set([
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
])

type Payload = { sessionID?: unknown; assistantMessageID?: unknown; id?: unknown; ordinal?: unknown }
type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>
type Kind = "text" | "reasoning"

const fragmentKind = (type: string): Kind | undefined =>
  type.startsWith("session.text.") ? "text" : type.startsWith("session.reasoning.") ? "reasoning" : undefined


function assistantOf(data: Data, event: OpenCodeEvent): { payload: Payload; messageId?: string; row?: Assistant } {
  const payload = event.data as Payload
  if (typeof payload.sessionID !== "string" || typeof payload.assistantMessageID !== "string") return { payload }
  const row = data.session.message.get(payload.sessionID, payload.assistantMessageID)
  return { payload, messageId: payload.assistantMessageID, row: row?.type === "assistant" ? row : undefined }
}

const countOf = (row: Assistant, kind: Kind) => row.content.filter((item) => item.type === kind).length

/** Classifies an event; consumes a `partial` mark it reports, so one delta
 * per ambiguous fragment owes the repair. */
export function fitLiveEvent(data: Data, fragments: PageFragments | undefined, event: OpenCodeEvent): EventFit {
  const type = event.type
  const kind = fragmentKind(type)
  const tool = TOOL_EVENTS.has(type) || type === "session.tool.input.started"
  if (!kind && !tool && !ASSISTANT_EVENTS.has(type)) return { kind: "apply" }
  const { payload, messageId, row } = assistantOf(data, event)
  if (messageId === undefined) return { kind: "apply" }
  const key = `${messageId}\0${kind ?? (tool ? "tool" : "")}\0${kind ? String(payload.ordinal ?? "") : tool ? String(payload.id) : ""}`
  if (!row) return { kind: "diverged", key, apply: true }
  if (tool) {
    const held = row.content.some((item) => item.type === "tool" && item.id === payload.id)
    if (type === "session.tool.input.started") return held ? { kind: "drop" } : { kind: "apply" }
    return held ? { kind: "apply" } : { kind: "diverged", key, apply: true }
  }
  if (!kind) return { kind: "apply" }
  const started = type.endsWith(".started")
  if (typeof payload.ordinal !== "number") {
    if (started) return { kind: "apply" }
    const held = row.content.some((item) => item.type === kind
      && (kind === "text" || !(item as { time?: { completed?: unknown } }).time?.completed))
    return held ? { kind: "apply" } : { kind: "diverged", key, apply: true }
  }
  const ordinal = payload.ordinal
  const count = countOf(row, kind)
  const expected = started ? ordinal : ordinal + 1
  if (count > expected) return { kind: "drop" }
  if (count < expected) return { kind: "diverged", key, apply: false }
  if (started) return { kind: "apply" }
  const fragment = fragmentKey(messageId, kind, ordinal)
  const provenance = fragments?.get(fragment)
  if (type.endsWith(".ended")) {
    // A full-text ending is authoritative whatever the page held.
    fragments?.delete(fragment)
    return { kind: "apply", settles: key }
  }
  if (provenance === "closed") return { kind: "drop" }
  if (provenance === "partial") {
    // Redelivered or new cannot be told apart: apply it; its ending replaces
    // the text, and a lost ending leaves the settlement read owed.
    fragments!.delete(fragment)
    return { kind: "diverged", key, apply: true, settlement: true }
  }
  return { kind: "apply" }
}

/** Whether a page now holds what a missed event targeted: its message and, for
 * part events, that part (the tool by ID; a fragment without an ordinal by
 * kind). Fragments with an ordinal settle by provenance instead. */
export function holdsEventTarget(data: Data, event: OpenCodeEvent): boolean {
  const { payload, row } = assistantOf(data, event)
  if (!row) return false
  if (TOOL_EVENTS.has(event.type) || event.type === "session.tool.input.started") {
    return row.content.some((item) => item.type === "tool" && item.id === payload.id)
  }
  const kind = fragmentKind(event.type)
  if (!kind) return true
  return countOf(row, kind) > (typeof payload.ordinal === "number" ? payload.ordinal : 0)
}

/** The fragment key of a text or reasoning event with an ordinal: what a
 * fragment obligation is recorded under. */
export function eventFragmentKey(event: OpenCodeEvent | undefined): string | undefined {
  const kind = event ? fragmentKind(event.type) : undefined
  const payload = event?.data as Payload | undefined
  if (!kind || typeof payload?.assistantMessageID !== "string" || typeof payload.ordinal !== "number") return undefined
  return fragmentKey(payload.assistantMessageID, kind, payload.ordinal)
}

type Fragment = { type?: unknown; text?: unknown; time?: { completed?: unknown } }

/** The provenance of fragments a page installed (`installed`, after the read
 * merge) exactly as fetched: a fragment the merge kept live belongs to the
 * stream. A committed fragment (`isCommittedFragment`) is closed; an open fragment
 * holding text is partial; an empty open one simply streams. */
export function recordPageFragments(fetched: readonly SessionMessageInfo[], installed: readonly SessionMessageInfo[]): PageFragments {
  const fragments: PageFragments = new Map()
  const installedById = new Map(installed.map((row) => [row.id, row]))
  for (const row of fetched) {
    const live = installedById.get(row.id)
    if (row.type !== "assistant" || live?.type !== "assistant") continue
    for (const kind of ["text", "reasoning"] as const) {
      const installedParts = live.content.filter((item) => item.type === kind) as Fragment[]
      ;(row.content.filter((item) => item.type === kind) as Fragment[]).forEach((part, ordinal) => {
        if (installedParts[ordinal]?.text !== part.text) return
        if (isCommittedFragment(row, kind, part)) fragments.set(fragmentKey(row.id, kind, ordinal), "closed")
        else if (part.text !== "") fragments.set(fragmentKey(row.id, kind, ordinal), "partial")
      })
    }
  }
  return fragments
}
