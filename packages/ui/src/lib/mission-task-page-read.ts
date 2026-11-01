import { z } from "zod"
import { MISSION_TASK_PAGE, MISSION_TASK_REPORT_ROWS, type MissionPanelTask, type MissionPanelReport, type MissionTaskPageResponse, type MissionTaskRequest } from "../../../server/src/missions/mission-panel-map"

// Independent consumer limits; tests pin these to the server's wire contract without
// importing its Node-only paginator into the browser.
export const TASK_PAGE_RESPONSE_BYTES = 64 * 1024, TASK_PAGE_REQUEST_BYTES = 16 * 1024
export type MissionTaskPageFailure = "changed" | "unavailable" | "invalid" | "damaged"
export class MissionTaskPageReadError extends Error {
  constructor(readonly reason: MissionTaskPageFailure) { super(`Mission task page: ${reason}`) }
}
const count = z.number().int().nonnegative().safe(), digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const cursorSchema = z.object({ digest, index: count, offset: count }).strict()
const envelopeSchema = z.object({ available: z.literal(true), version: z.literal(1), projectID: z.string(), source: z.literal("tasks"),
  missionID: z.string(), revision: count, discardedEvents: count, controlUnavailable: z.boolean(), notificationUnavailable: z.boolean(), cleanupUnavailable: z.boolean(),
  page: z.object({ digest, total: z.literal(1), pieces: z.array(z.object({ index: z.literal(0), offset: count, characters: count, text: z.string().min(1) }).strict()).min(1).max(50),
    next: cursorSchema.optional() }).strict(),
}).strict()
const counts = z.record(count)
const rowSchema = z.object({ taskPage: z.object({ order: digest, offset: count, end: count, total: count, counts, reports: count,
  attention: z.object({ counts: z.object({ notifications: count, blocked: count, failed: count, recovery: count }).passthrough(), omitted: count,
    sequence: digest, keys: z.array(z.string()).max(MISSION_TASK_PAGE).optional(), offset: count.optional(), end: count.optional() }).passthrough().optional(),
}).passthrough(), tasks: z.array(z.object({ id: z.string().min(1), key: z.string().min(1), title: z.string(), role: z.string(),
  status: z.enum(["blocked", "ready", "dispatching", "queued", "completed", "needs-input", "failed", "withdrawn"]),
  blockedBy: z.array(z.string()), order: count, createdAt: count, updatedAt: count, outstandingExecution: z.boolean(),
}).passthrough()).max(MISSION_TASK_PAGE), reports: z.array(z.object({ id: z.string().min(1), taskKey: z.string(), sessionId: z.string(),
  outcome: z.enum(["completed", "blocked", "failed"]), createdAt: count }).passthrough())
  .max(MISSION_TASK_PAGE * (MISSION_TASK_REPORT_ROWS + 1)),
}).passthrough()

/** Native digests hash UTF-16LE code units, including unpaired surrogates. */
export async function taskPageDigest(text: string): Promise<string> {
  const bytes = new Uint8Array(text.length * 2), view = new DataView(bytes.buffer)
  for (let index = 0; index < text.length; index++) view.setUint16(index * 2, text.charCodeAt(index), true)
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return btoa(String.fromCharCode(...hash)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Bound the actual body (whitespace included), before parsing untrusted JSON. */
async function body(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new MissionTaskPageReadError("invalid")
  let text = "", bytes = 0
  const decoder = new TextDecoder("utf-8", { fatal: true })
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > TASK_PAGE_RESPONSE_BYTES) throw new MissionTaskPageReadError("invalid")
      text += decoder.decode(next.value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** One deliberately requested task window or named read. Partial text lives only in
 * this operation; failures park the logical selector in the existing task store.
 * Explicit Retry starts at its first slice. Never restart or fall back to old reads. */
export async function readMissionTaskPage(missionID: string, task: MissionTaskRequest, input: {
  projectID: string; current(): boolean; exchange(body: string): Promise<Response>
}): Promise<MissionTaskPageResponse> {
  task = structuredClone(task)
  let cursor: z.infer<typeof cursorSchema> | undefined, text = "", first: z.infer<typeof envelopeSchema> | undefined, characters: number | undefined
  const assertCurrent = () => { if (!input.current()) throw new DOMException("Obsolete task read", "AbortError") }
  do {
    assertCurrent()
    const request = JSON.stringify({ source: "tasks", task: { ...task, missionID }, ...(cursor ? { cursor } : {}) })
    if (new TextEncoder().encode(request).length > TASK_PAGE_REQUEST_BYTES) throw new MissionTaskPageReadError("invalid")
    const response = await input.exchange(request)
    assertCurrent()
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new MissionTaskPageReadError("unavailable") }
    const value = await body(response)
    assertCurrent()
    if (value && typeof value === "object" && "available" in value && value.available === false) {
      throw new MissionTaskPageReadError("reason" in value && value.reason === "changed" ? "changed" : "unavailable")
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
      text += piece.text
    }
    cursor = result.page.next
    if (cursor ? cursor.digest !== first.page.digest || cursor.index !== 0 || cursor.offset !== text.length || cursor.offset >= characters!
      : text.length !== characters) throw new MissionTaskPageReadError("invalid")
  } while (cursor)
  if (await taskPageDigest(`[${text}]`) !== first!.page.digest) throw new MissionTaskPageReadError("invalid")
  assertCurrent()
  const parsed = rowSchema.safeParse(JSON.parse(text))
  if (!parsed.success) throw new MissionTaskPageReadError("invalid")
  const row = parsed.data, page = row.taskPage
  if (task.order !== undefined && page.order !== task.order) throw new MissionTaskPageReadError("changed")
  if (page.offset > page.end || page.end > page.total || row.tasks.some(value => value.order >= page.total)
    || new Set(row.tasks.map(value => value.order)).size !== row.tasks.length
    || new Set(row.tasks.map(value => value.id)).size !== row.tasks.length || new Set(row.tasks.map(value => value.key)).size !== row.tasks.length
    || new Set(row.reports.map(value => value.id)).size !== row.reports.length
    || task.offset !== undefined && (page.offset !== Math.min(task.offset, page.total) || page.end !== Math.min(page.offset + MISSION_TASK_PAGE, page.total)
      || row.tasks.length !== page.end - page.offset || row.tasks.some(value => value.order < page.offset || value.order >= page.end))
    || task.attention !== undefined && (!page.attention || page.attention.offset !== Math.min(task.attention, page.attention.omitted)
      || page.attention.end !== Math.min(page.attention.offset + MISSION_TASK_PAGE, page.attention.omitted)
      || row.tasks.length !== page.attention.end - page.attention.offset)) throw new MissionTaskPageReadError("invalid")
  return { ...row, available: true, version: 1, projectID: first!.projectID, missionID, revision: first!.revision,
    tasks: row.tasks as MissionPanelTask[], reports: row.reports as MissionPanelReport[] }
}
