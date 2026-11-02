import { z } from "zod"
import { sha256 } from "@noble/hashes/sha2.js"
import type { MissionTaskPageResponse, MissionTaskRequest } from "../../../server/src/missions/mission-panel-map"
import type { MissionPanelPageRequest, MissionPanelPage } from "../../../server/src/missions/mission-panel-wire"
import { taskCount as count, taskDigest as digest, taskRowSchema, validTaskSelection, type MissionTaskPageContext } from "./mission-task-page-schema"
import { assertTaskReadLive, raceTaskRead, TASK_READ_TIMEOUT_MS, MissionTaskPageReadError } from "./mission-task-read-lifetime"
import { MissionTaskWindowBudget, TASK_WINDOW_CHARACTERS } from "./mission-task-window-budget"
export { MissionTaskPageReadError, type MissionTaskPageFailure } from "./mission-task-read-lifetime"

// Independent consumer limits; tests pin these to the server's wire contract without
// importing its Node-only paginator into the browser.
export const TASK_PAGE_RESPONSE_BYTES = 64 * 1024, TASK_PAGE_REQUEST_BYTES = 16 * 1024
const cursorSchema = z.object({ digest, index: count, offset: count }).strict()
const envelopeSchema = z.object({ available: z.literal(true), version: z.literal(1), projectID: z.string(), source: z.literal("tasks"),
  missionID: z.string(), revision: count, discardedEvents: count, controlUnavailable: z.boolean(), notificationUnavailable: z.boolean(), cleanupUnavailable: z.boolean(),
  page: z.object({ digest, total: z.literal(1), pieces: z.array(z.object({ index: z.literal(0), offset: count, characters: count, text: z.string().min(1) }).strict()).min(1).max(50),
    next: cursorSchema.optional() }).strict(),
}).strict()
const refusalSchema = z.union([
  z.object({ available: z.literal(false), reason: z.enum(["invalid-request", "changed", "mission-not-found", "field-not-found", "invalid-cursor", "damaged", "observation-unavailable"]) }).strict(),
  z.object({ available: z.literal(false), reason: z.enum(["host-unavailable", "plugin-unavailable", "plugin-failed", "workspace-unavailable"]), missions: z.tuple([]) }).strict(),
])

/** Native digests hash UTF-16LE code units, including unpaired surrogates. */
export async function taskPageDigest(text: string, signal?: AbortSignal, deadline = Infinity, maximum = TASK_WINDOW_CHARACTERS): Promise<string> {
  assertTaskReadLive(signal, deadline)
  if (text.length > maximum + 2) throw new MissionTaskPageReadError("too-large")
  const bytes = new Uint8Array(text.length * 2), view = new DataView(bytes.buffer)
  for (let index = 0; index < text.length; index++) {
    if (index % 8192 === 0) assertTaskReadLive(signal, deadline)
    view.setUint16(index * 2, text.charCodeAt(index), true)
  }
  const hash = globalThis.crypto?.subtle ? new Uint8Array(await raceTaskRead(crypto.subtle.digest("SHA-256", bytes), signal)) : sha256(bytes)
  assertTaskReadLive(signal, deadline)
  return btoa(String.fromCharCode(...hash)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Shared slot-owning response boundary for the task and inventory consumers. */
async function panelResponse(response: Response, signal: AbortSignal, budget: MissionTaskWindowBudget, failed: (error: unknown) => void): Promise<unknown> {
  try {
    signal.throwIfAborted()
    if (!response.ok) throw new MissionTaskPageReadError("unavailable")
    return await body(response, signal, budget, failed)
  } catch (error) { failed(error); throw error }
  finally { if (response.body && !response.bodyUsed) await raceTaskRead(response.body.cancel(), signal).catch(() => {}) }
}

function parseTaskJSON(text: string): unknown {
  try {
    return JSON.parse(text, (key, value: unknown) => {
      if (key === "__proto__") throw new MissionTaskPageReadError("invalid") // refuse keys that object validators deliberately omit
      return value
    })
  } catch { throw new MissionTaskPageReadError("invalid") }
}
/** Bound the actual body (whitespace included), before parsing untrusted JSON. */
async function body(response: Response, signal: AbortSignal, budget: MissionTaskWindowBudget, failed: (error: unknown) => void): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new MissionTaskPageReadError("invalid")
  let text = "", bytes = 0, consumed = false, cancellation: Promise<void> | undefined
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const decode = (chunk?: Uint8Array, stream = false) => {
    try { return decoder.decode(chunk, { stream }) } catch { throw new MissionTaskPageReadError("invalid") }
  }
  const cancel = () => cancellation ??= reader.cancel(signal.reason)
  const abort = () => { void cancel().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await raceTaskRead(reader.read(), signal)
      if (next.done) { consumed = true; break }
      bytes += next.value.byteLength
      if (bytes > TASK_PAGE_RESPONSE_BYTES) throw new MissionTaskPageReadError("invalid")
      budget.transfer(next.value.byteLength)
      text += decode(next.value, true)
    }
    text += decode()
    signal.throwIfAborted()
    return parseTaskJSON(text)
  } catch (error) { failed(error); throw error }
  finally {
    signal.removeEventListener("abort", abort)
    try { if (!consumed) await raceTaskRead(cancel(), signal).catch(() => {}) }
    finally { reader.releaseLock() }
  }
}

/** One deliberately requested task window or named read. Partial text lives only in
 * this operation; failures park the logical selector in the existing task store.
 * Explicit Retry starts at its first slice. Never restart or fall back to old reads. */
export async function readMissionTaskPage(missionID: string, task: MissionTaskRequest, input: {
  projectID: string; current(): boolean; exchange(body: string): Promise<Response>; signal?: AbortSignal; deadline?: number
  context?: MissionTaskPageContext
  runTransfer?: <T>(read: () => Promise<T>) => Promise<T>
}): Promise<MissionTaskPageResponse> {
  task = structuredClone(task)
  const deadline = Math.min(input.deadline ?? Infinity, performance.now() + TASK_READ_TIMEOUT_MS)
  const timeout = AbortSignal.timeout(Math.max(0, Math.ceil(deadline - performance.now())))
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout, budget = new MissionTaskWindowBudget()
  let cursor: z.infer<typeof cursorSchema> | undefined, text = "", first: z.infer<typeof envelopeSchema> | undefined, characters: number | undefined
  const assertCurrent = () => {
    if (!input.current()) throw new DOMException("Obsolete task read", "AbortError")
    assertTaskReadLive(signal, deadline)
  }
  do {
    assertCurrent()
    const request = JSON.stringify({ source: "tasks", task: { ...task, missionID }, ...(cursor ? { cursor } : {}) })
    if (new TextEncoder().encode(request).length > TASK_PAGE_REQUEST_BYTES) throw new MissionTaskPageReadError("invalid")
    let failure: { error: unknown } | undefined
    const failed = (error: unknown) => { failure ??= { error } }
    const transfer = async () => {
      assertCurrent()
      const response = await input.exchange(request)
      return panelResponse(response, signal, budget, failed)
    }
    let value: unknown
    try { value = await raceTaskRead(input.runTransfer ? input.runTransfer(transfer) : transfer(), signal) }
    catch (error) { throw failure ? failure.error : error } // cleanup expiry/rejection never replaces the read's original failure
    assertCurrent()
    if (value && typeof value === "object" && "available" in value && value.available === false) {
      const refusal = refusalSchema.safeParse(value)
      if (!refusal.success) throw new MissionTaskPageReadError("invalid")
      const reason = refusal.data.reason
      throw new MissionTaskPageReadError(reason === "changed" || reason === "damaged" ? reason
        : reason === "invalid-cursor" || reason === "invalid-request" ? "invalid" : "unavailable", "missions" in refusal.data ? refusal.data.reason : undefined)
    }
    const decoded = envelopeSchema.safeParse(value)
    if (!decoded.success) throw new MissionTaskPageReadError("invalid")
    const result = decoded.data
    if (result.projectID !== input.projectID || result.missionID !== missionID || first && (result.page.digest !== first.page.digest || result.revision !== first.revision
      || result.discardedEvents !== first.discardedEvents || result.controlUnavailable !== first.controlUnavailable
      || result.notificationUnavailable !== first.notificationUnavailable || result.cleanupUnavailable !== first.cleanupUnavailable)) throw new MissionTaskPageReadError("invalid")
    first ??= result
    if (result.discardedEvents || result.controlUnavailable || result.notificationUnavailable || result.cleanupUnavailable) throw new MissionTaskPageReadError("damaged")
    for (const piece of result.page.pieces) {
      characters ??= piece.characters
      if (piece.offset !== text.length || piece.characters !== characters || text.length + piece.text.length > characters) throw new MissionTaskPageReadError("invalid")
      budget.append(piece.text, characters)
      text += piece.text
    }
    cursor = result.page.next
    if (cursor ? cursor.digest !== first.page.digest || cursor.index !== 0 || cursor.offset !== text.length || cursor.offset >= characters!
      : text.length !== characters) throw new MissionTaskPageReadError("invalid")
  } while (cursor)
  if (await taskPageDigest(`[${text}]`, signal, deadline) !== first!.page.digest) throw new MissionTaskPageReadError("invalid")
  assertCurrent()
  const parsed = taskRowSchema.safeParse(parseTaskJSON(text))
  if (!parsed.success) throw new MissionTaskPageReadError("invalid")
  const row = parsed.data, page = row.taskPage
  if (task.order !== undefined && page.order !== task.order) throw new MissionTaskPageReadError("changed")
  if (!validTaskSelection(task, row, input.context, first!.revision)) throw new MissionTaskPageReadError("invalid")
  assertCurrent()
  return { ...row, available: true, version: 1, projectID: first!.projectID, missionID, revision: first!.revision,
    tasks: row.tasks, reports: row.reports }
}

const panelEnvelope = z.object({ available: z.literal(true), version: z.literal(1), projectID: z.string().min(1).max(240),
  source: z.enum(["summaries", "cleanups", "mission", "activity", "marks"]), missionID: z.string().optional(), field: z.string().optional(), part: z.enum(["receipts", "pending"]).optional(), text: z.literal(true).optional(),
  revision: count.optional(), header: z.literal(true).optional(), finishHighWater: count.optional(), phase: z.enum(["context", "observed"]).optional(), observedAt: z.number().finite().optional(),
  discardedEvents: count, controlUnavailable: z.boolean(), notificationUnavailable: z.boolean(), cleanupUnavailable: z.boolean(),
  window: z.object({ order: digest, offset: count, end: count, total: count }).strict().optional(),
  page: z.object({ digest, total: count.max(50), pieces: z.array(z.object({ index: count.max(49), offset: count, characters: count, text: z.string().min(1) }).strict()).max(50), next: cursorSchema.optional() }).strict(),
}).strict()
export interface MissionPanelReadScope {
  projectID?: string; signal?: AbortSignal; deadline?: number; current(): boolean
  onFinishHighWater?: (projectID: string, value: number) => void
}
export class MissionPanelMissingError extends MissionTaskPageReadError {
  constructor() { super("unavailable") }
}

/** A single selected logical window, never a traversal of unseen inventory. Schema
 * and selector adoption belong to the inventory consumer after this integrity boundary. */
export async function readMissionPanelWindow(selector: Exclude<MissionPanelPageRequest, { source: "tasks" }>, input: MissionPanelReadScope & {
  exchange(body: string): Promise<Response>; runTransfer<T>(read: () => Promise<T>): Promise<T>
}): Promise<{ envelope: MissionPanelPage; values: unknown[] }> {
  selector = structuredClone(selector)
  const maximum = selector.source === "summaries" || selector.source === "mission" && selector.text ? 256 * 1024 : selector.source === "mission" && selector.header ? 1024 * 1024
    : selector.source === "activity" || selector.source === "marks" ? 24 * 1024 * 1024 : TASK_WINDOW_CHARACTERS
  const deadline = Math.min(input.deadline ?? Infinity, performance.now() + TASK_READ_TIMEOUT_MS), timeout = AbortSignal.timeout(Math.max(0, Math.ceil(deadline - performance.now())))
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout, budget = new MissionTaskWindowBudget(maximum)
  const live = () => { if (!input.current()) throw new DOMException("Obsolete panel read", "AbortError"); assertTaskReadLive(signal, deadline) }
  let cursor: z.infer<typeof cursorSchema> | undefined, first: z.infer<typeof panelEnvelope> | undefined
  const texts: string[] = [], lengths: number[] = []
  let index = 0
  do {
    live()
    const request = JSON.stringify({ ...selector, ...(cursor ? { cursor } : {}) })
    if (new TextEncoder().encode(request).length > TASK_PAGE_REQUEST_BYTES) throw new MissionTaskPageReadError("invalid")
    let failure: { error: unknown } | undefined
    const failed = (error: unknown) => { failure ??= { error } }
    let value: unknown
    try { value = await raceTaskRead(input.runTransfer(async () => { live(); return panelResponse(await input.exchange(request), signal, budget, failed) }), signal) }
    catch (error) { throw failure ? failure.error : error }
    live()
    if (value && typeof value === "object" && "available" in value && value.available === false) {
      const refusal = refusalSchema.safeParse(value)
      if (!refusal.success) throw new MissionTaskPageReadError("invalid")
      if (refusal.data.reason === "mission-not-found") throw new MissionPanelMissingError()
      throw new MissionTaskPageReadError(refusal.data.reason === "changed" || refusal.data.reason === "damaged" ? refusal.data.reason
        : refusal.data.reason === "invalid-cursor" || refusal.data.reason === "invalid-request" ? "invalid" : "unavailable", "missions" in refusal.data ? refusal.data.reason : undefined)
    }
    const parsed = panelEnvelope.safeParse(value)
    if (!parsed.success) throw new MissionTaskPageReadError("invalid")
    const own = parsed.data, range = own.window
    const selectedRange = "window" in selector ? selector.window : undefined
    if (own.source !== selector.source || input.projectID && own.projectID !== input.projectID
      || own.missionID !== (selector.source === "mission" || selector.source === "activity" ? selector.missionID : undefined)
      || own.field !== (selector.source === "mission" ? selector.field : undefined) || own.part !== (selector.source === "mission" ? selector.part : undefined) || own.text !== (selector.source === "mission" ? selector.text : undefined) || own.header !== (selector.source === "mission" ? selector.header : undefined)
      || (selector.source === "mission" || selector.source === "activity" ? own.revision === undefined : own.revision !== undefined)
      || (selector.source === "activity" || selector.source === "marks" ? own.phase !== "observed" || own.observedAt === undefined : own.phase !== undefined || own.observedAt !== undefined)
      || Boolean(selectedRange) !== Boolean(range) || range && (range.offset !== Math.min(selectedRange!.offset, range.total) || range.end !== Math.min(range.offset + (selector.source === "mission" && selector.text ? 1 : 50), range.total)
        || own.page.total !== range.end - range.offset || selectedRange!.order !== undefined && selectedRange!.order !== range.order)) throw new MissionTaskPageReadError("invalid")
    if (first && (own.revision !== first.revision || own.window?.order !== first.window?.order)) throw new MissionTaskPageReadError("changed")
    if (first && (own.projectID !== first.projectID || own.page.digest !== first.page.digest || own.page.total !== first.page.total
      || JSON.stringify(own.window) !== JSON.stringify(first.window) || ["discardedEvents", "controlUnavailable", "notificationUnavailable", "cleanupUnavailable"].some(key => own[key as keyof typeof own] !== first![key as keyof typeof own]))) throw new MissionTaskPageReadError("invalid")
    if (own.discardedEvents || own.controlUnavailable || own.notificationUnavailable || own.cleanupUnavailable) throw new MissionTaskPageReadError("damaged")
    if (!first && selector.source === "summaries" && selector.initial) {
      if (own.finishHighWater === undefined) throw new MissionTaskPageReadError("invalid")
      input.onFinishHighWater?.(own.projectID, own.finishHighWater)
    }
    first ??= own
    if (selectedRange && range && selectedRange.order === undefined) selectedRange.order = range.order
    for (const piece of own.page.pieces) {
      if (piece.index !== index || piece.offset !== (texts[index]?.length ?? 0) || lengths[index] !== undefined && lengths[index] !== piece.characters
        || piece.offset + piece.text.length > piece.characters) throw new MissionTaskPageReadError("invalid")
      budget.append(piece.text, piece.characters)
      lengths[index] = piece.characters; texts[index] = (texts[index] ?? "") + piece.text
      if (texts[index].length === piece.characters) index++
    }
    cursor = own.page.next
    if (cursor ? cursor.digest !== own.page.digest || cursor.index !== index || cursor.offset !== (texts[index]?.length ?? 0)
      : index !== own.page.total) throw new MissionTaskPageReadError("invalid")
    if (cursor && !own.page.pieces.length) throw new MissionTaskPageReadError("invalid")
  } while (cursor)
  live()
  if (await taskPageDigest(`[${texts.join(",")}]`, signal, deadline, maximum + 50) !== first!.page.digest) throw new MissionTaskPageReadError("invalid")
  live()
  const values = texts.map(parseTaskJSON)
  live()
  return { envelope: first!, values }
}
