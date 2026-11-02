import { z } from "zod"
import { Exit, Schema, SchemaRepresentation } from "effect"
import { contentDigest } from "./inspect-view"
import { missionTaskRequestSchema } from "./mission-compact-map"
import type { MissionPanelCursor, MissionPanelPage, MissionPanelPageResult, MissionPanelPiece } from "./mission-panel-wire"
export type { MissionPanelCursor, MissionPanelPage, MissionPanelPageResult, MissionPanelPageRequest, MissionPanelPiece, MissionPanelPageFailure } from "./mission-panel-wire"

/** Opt-in display transport: budgets include the complete compact-JSON HTTP body, including
 * its envelope and continuations. Limits bind transfers and selectors, never source counts. */
export const MISSION_PANEL_PAGE_BYTES = 64 * 1024
export const MISSION_PANEL_REQUEST_BYTES = 16 * 1024
export const MISSION_PANEL_PAGE_ROWS = 50

const number = z.number().int().nonnegative().safe()
const window = z.object({ offset: number, order: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() }).strict()
export const missionPanelCursorSchema = z.object({ digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/), index: number, offset: number }).strict()
export const missionPanelPageRequestSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("summaries"), window: window.optional(), initial: z.literal(true).optional(), cursor: missionPanelCursorSchema.optional() }).strict(),
  z.object({ source: z.literal("cleanups"), window: window.optional(), cursor: missionPanelCursorSchema.optional() }).strict(),
  z.object({ source: z.literal("mission"), missionID: z.string().min(1).max(100),
    field: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(64).optional(), part: z.enum(["receipts", "pending"]).optional(), text: z.literal(true).optional(), header: z.literal(true).optional(), window: window.optional(), cursor: missionPanelCursorSchema.optional() }).strict(),
  z.object({ source: z.literal("tasks"), task: missionTaskRequestSchema, cursor: missionPanelCursorSchema.optional() }).strict(),
  z.object({ source: z.literal("activity"), missionID: z.string().min(1).max(100), actorOffset: number.optional(),
    actorOrder: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(), cursor: missionPanelCursorSchema.optional() }).strict(),
  z.object({ source: z.literal("marks"), missionOffset: number.optional(), missionOrder: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(), cursor: missionPanelCursorSchema.optional() }).strict(),
]).refine(value => value.source !== "mission" || !value.header || value.field === undefined && value.window === undefined,
  "A header has no field/window").refine(value => value.source !== "mission" || value.part === undefined || value.field === "control" && !value.header,
  "Control parts belong to the control field").refine(value => value.source !== "mission" || !value.text || value.field !== undefined && value.window !== undefined && !value.header,
  "Text windows name a field and window").refine(value => Buffer.byteLength(JSON.stringify(value)) <= MISSION_PANEL_REQUEST_BYTES, "Mission panel selector exceeds its byte budget")

/** One row's exact JSON, or a slice of it. Join slices by index and offset, parse only
 * once characters have all arrived. A partial row supplies no absence or mutation evidence. */

/** Independent logical windows: content commits this window; order commits the whole
 * chosen collection, including row values, so a stale continuation refuses. */
export function missionPanelWindow(header: Omit<MissionPanelPage, "page" | "available" | "version">,
  values: readonly unknown[], selection: { offset: number; order?: string }, cursor?: MissionPanelCursor): MissionPanelPageResult {
  const order = contentDigest(JSON.stringify(values)), offset = Math.min(selection.offset, values.length), end = Math.min(offset + MISSION_PANEL_PAGE_ROWS, values.length)
  if (selection.order !== undefined && selection.order !== order) return { available: false, reason: "changed" }
  return missionPanelPage({ ...header, window: { order, offset, end, total: values.length } }, values.slice(offset, end), cursor)
}

/** Exact raw JSON fields remain readable without assembling an arbitrarily wide
 * scalar/row in the renderer. One logical row is one surrogate-safe 32 Ki-unit
 * text window; its collection identity commits the complete field JSON. */
export function missionPanelTextWindow(header: Omit<MissionPanelPage, "page" | "available" | "version">, value: unknown,
  selection: { offset: number; order?: string }, cursor?: MissionPanelCursor): MissionPanelPageResult {
  const text = JSON.stringify(value) ?? "null", order = contentDigest(text), total = Math.ceil(text.length / 32768), offset = Math.min(selection.offset, total), end = Math.min(offset + 1, total)
  if (selection.order !== undefined && selection.order !== order) return { available: false, reason: "changed" }
  const boundary = (at: number) => at < text.length && /[\uDC00-\uDFFF]/.test(text[at] ?? "") && /[\uD800-\uDBFF]/.test(text[at - 1] ?? "") ? at - 1 : Math.min(at, text.length)
  return missionPanelPage({ ...header, text: true, window: { order, offset, end, total } }, offset < total ? [text.slice(boundary(offset * 32768), boundary(end * 32768))] : [], cursor)
}

/** UTF-8 bytes on the wire, including JSON escaping and every nested field. */
export const missionPanelBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

/** Pages exact rows. Cursor digests pin this collection alone, so unrelated source edits
 * leave a traversal valid. Even a single oversized row progresses through text slices;
 * every answer is measured as serialized, with its continuation included. */
export function missionPanelPage(header: Omit<MissionPanelPage, "page" | "available" | "version">,
  values: readonly unknown[], cursor?: MissionPanelCursor): MissionPanelPageResult {
  // The same representation used at the RPC boundary: unknown bounded extension fields
  // survive; optional undefined properties disappear. Each row is serialized once.
  const texts = values.map(value => JSON.stringify(value) ?? "null")
  const digest = contentDigest(`[${texts.join(",")}]`)
  if (cursor && cursor.digest !== digest) return { available: false, reason: "changed" }
  let index = cursor?.index ?? 0, offset = cursor?.offset ?? 0
  if (index > texts.length || offset > (texts[index]?.length ?? 0) || (index === texts.length && offset !== 0)
    || (offset > 0 && offset === texts[index]?.length)) return { available: false, reason: "invalid-cursor" }
  const pieces: MissionPanelPiece[] = []
  const answer = (rows: MissionPanelPiece[], at: number, from: number): MissionPanelPage => ({
    available: true, version: 1, ...header, page: { digest, total: texts.length, pieces: rows,
      ...(at < texts.length ? { next: { digest, index: at, offset: from } } : {}) },
  })
  while (index < texts.length && pieces.length < MISSION_PANEL_PAGE_ROWS) {
    const text = texts[index], piece = { index, offset, characters: text.length, text: text.slice(offset) }
    if (missionPanelBytes(answer([...pieces, piece], index + 1, 0)) <= MISSION_PANEL_PAGE_BYTES) {
      pieces.push(piece); index++; offset = 0; continue
    }
    if (pieces.length) break
    // One row is wider than a transfer: the largest prefix whose own escaped JSON and
    // continuation fit. Avoid splitting a surrogate pair across slices.
    let low = offset, high = text.length
    while (low < high) {
      const end = Math.ceil((low + high) / 2)
      if (missionPanelBytes(answer([{ ...piece, text: text.slice(offset, end) }], index, end)) <= MISSION_PANEL_PAGE_BYTES) low = end
      else high = end - 1
    }
    if (low < text.length && /[\uD800-\uDBFF]/.test(text[low - 1] ?? "")) low--
    if (low <= offset) throw new Error("Mission panel page envelope exceeds its byte budget")
    pieces.push({ ...piece, text: text.slice(offset, low) }); offset = low
    break
  }
  const result = answer(pieces, index, offset)
  if (missionPanelBytes(result) > MISSION_PANEL_PAGE_BYTES) throw new Error("Mission panel page exceeds its byte budget")
  return result
}

const count = { type: "integer", minimum: 0 } as const
const cursor = { type: "object", properties: { digest: { type: "string", minLength: 43, maxLength: 43 }, index: count, offset: count },
  required: ["digest", "index", "offset"], additionalProperties: false } as const
const windowInput = { type: "object", properties: { offset: count, order: { type: "string", minLength: 43, maxLength: 43 } }, required: ["offset"], additionalProperties: false } as const
const windowOutput = { type: "object", properties: { offset: count, end: count, total: count, order: { type: "string", minLength: 43, maxLength: 43 } }, required: ["order", "offset", "end", "total"], additionalProperties: false } as const
export const missionPanelPageInputSchema = {
  type: "object", properties: {
    source: { type: "string", enum: ["summaries", "cleanups", "mission", "tasks", "activity", "marks"] }, cursor, window: windowInput, initial: { type: "boolean", const: true }, header: { type: "boolean", const: true }, text: { type: "boolean", const: true }, actorOffset: count, missionOffset: count,
    actorOrder: { type: "string", minLength: 43, maxLength: 43 }, missionOrder: { type: "string", minLength: 43, maxLength: 43 },
    missionID: { type: "string", minLength: 1, maxLength: 100 }, field: { type: "string", minLength: 1, maxLength: 64 }, part: { type: "string", enum: ["receipts", "pending"] },
    task: { type: "object", properties: { missionID: { type: "string", minLength: 1, maxLength: 100 },
      order: { type: "string", maxLength: 64 }, offset: count, attention: count,
      keys: { type: "array", maxItems: 50, items: { type: "string", maxLength: 64 } },
      ids: { type: "array", maxItems: 50, items: { type: "string", maxLength: 240 } },
      reportIds: { type: "array", maxItems: 50, items: { type: "string", maxLength: 240 } },
    }, required: ["missionID"], additionalProperties: false },
  }, required: ["source"], additionalProperties: false,
} as const
/** Schemas registered by the native plugin; the handler checks cross-field selectors and bytes. */
export const missionPanelPageOutputSchema = {
  // Complete alternatives, rather than a union intersected with common root properties:
  // this is the portable native JSON-Schema form consumed by OpenCode.
  oneOf: [{ type: "object", properties: {
    available: { type: "boolean", const: true }, version: { type: "integer", const: 1 }, projectID: { type: "string", maxLength: 240 },
    source: { type: "string", enum: ["summaries", "cleanups", "mission", "tasks", "activity", "marks"] }, missionID: { type: "string", maxLength: 100 },
    field: { type: "string", maxLength: 64 }, part: { type: "string", enum: ["receipts", "pending"] }, text: { type: "boolean", const: true }, revision: count, discardedEvents: count, window: windowOutput, header: { type: "boolean", const: true }, finishHighWater: count,
    phase: { type: "string", enum: ["context", "observed"] }, observedAt: { type: "number" },
    controlUnavailable: { type: "boolean" }, notificationUnavailable: { type: "boolean" }, cleanupUnavailable: { type: "boolean" },
    page: { type: "object", properties: { digest: { type: "string", minLength: 43, maxLength: 43 }, total: count, next: cursor,
      pieces: { type: "array", maxItems: MISSION_PANEL_PAGE_ROWS, items: { type: "object", properties: {
        index: count, offset: count, characters: count, text: { type: "string", maxLength: MISSION_PANEL_PAGE_BYTES },
      }, required: ["index", "offset", "characters", "text"], additionalProperties: false } },
    }, required: ["digest", "total", "pieces"], additionalProperties: false },
  }, required: ["available", "version", "projectID", "source", "page"], additionalProperties: false },
  { type: "object", properties: { available: { type: "boolean", const: false },
    reason: { type: "string", enum: ["invalid-request", "changed", "mission-not-found", "field-not-found", "invalid-cursor", "damaged", "observation-unavailable"] },
  }, required: ["available", "reason"], additionalProperties: false }],
} as const

// The same portable schema at the HTTP seam: reject excess fields rather than stripping
// them, and let the route keep its independent byte and requested-source identity checks.
const decodePanelPage = Schema.decodeUnknownExit(Schema.toType(SchemaRepresentation.fromJsonSchemaDocument({
  dialect: "draft-2020-12", schema: missionPanelPageOutputSchema, definitions: {},
})), { onExcessProperty: "error" })

export function isMissionPanelPageResult(value: unknown): value is MissionPanelPageResult {
  return Exit.isSuccess(decodePanelPage(value))
}
