import { z } from "zod"
import { contentDigest } from "./inspect-view"
import { missionTaskRequestSchema } from "./mission-compact-map"

/** Opt-in display transport: budgets include the complete compact-JSON HTTP body, including
 * its envelope and continuations. Limits bind transfers and selectors, never source counts. */
export const MISSION_PANEL_PAGE_BYTES = 64 * 1024
export const MISSION_PANEL_REQUEST_BYTES = 16 * 1024
export const MISSION_PANEL_PAGE_ROWS = 50

const number = z.number().int().nonnegative().safe()
export const missionPanelCursorSchema = z.object({ digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/), index: number, offset: number }).strict()
export const missionPanelPageRequestSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("summaries"), cursor: missionPanelCursorSchema.optional() }).strict(),
  z.object({ source: z.literal("cleanups"), cursor: missionPanelCursorSchema.optional() }).strict(),
  z.object({ source: z.literal("mission"), missionID: z.string().min(1).max(100),
    field: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(64).optional(), cursor: missionPanelCursorSchema.optional() }).strict(),
  z.object({ source: z.literal("tasks"), task: missionTaskRequestSchema, cursor: missionPanelCursorSchema.optional() }).strict(),
]).refine(value => Buffer.byteLength(JSON.stringify(value)) <= MISSION_PANEL_REQUEST_BYTES, "Mission panel selector exceeds its byte budget")

export type MissionPanelPageRequest = z.infer<typeof missionPanelPageRequestSchema>
export type MissionPanelCursor = z.infer<typeof missionPanelCursorSchema>
/** One row's exact JSON, or a slice of it. Join slices by index and offset, parse only
 * once characters have all arrived. A partial row supplies no absence or mutation evidence. */
export interface MissionPanelPiece { index: number; offset: number; characters: number; text: string }
export interface MissionPanelPage {
  available: true
  version: 1
  projectID: string
  source: MissionPanelPageRequest["source"]
  missionID?: string
  field?: string
  revision?: number
  discardedEvents?: number
  controlUnavailable?: boolean
  notificationUnavailable?: boolean
  cleanupUnavailable?: boolean
  page: { digest: string; total: number; pieces: MissionPanelPiece[]; next?: MissionPanelCursor }
}
export type MissionPanelPageFailure = { available: false; reason: "invalid-request" | "changed" | "mission-not-found" | "field-not-found" | "invalid-cursor" }
export type MissionPanelPageResult = MissionPanelPage | MissionPanelPageFailure

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
export const missionPanelPageInputSchema = {
  type: "object", properties: {
    source: { type: "string", enum: ["summaries", "cleanups", "mission", "tasks"] }, cursor,
    missionID: { type: "string", minLength: 1, maxLength: 100 }, field: { type: "string", minLength: 1, maxLength: 64 },
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
  type: "object", properties: {
    available: { type: "boolean" }, version: { type: "integer", const: 1 }, projectID: { type: "string", maxLength: 240 },
    source: { type: "string", enum: ["summaries", "cleanups", "mission", "tasks"] }, missionID: { type: "string", maxLength: 100 },
    field: { type: "string", maxLength: 64 }, revision: count, discardedEvents: count,
    controlUnavailable: { type: "boolean" }, notificationUnavailable: { type: "boolean" }, cleanupUnavailable: { type: "boolean" },
    reason: { type: "string", enum: ["invalid-request", "changed", "mission-not-found", "field-not-found", "invalid-cursor"] },
    page: { type: "object", properties: { digest: { type: "string", minLength: 43, maxLength: 43 }, total: count, next: cursor,
      pieces: { type: "array", maxItems: MISSION_PANEL_PAGE_ROWS, items: { type: "object", properties: {
        index: count, offset: count, characters: count, text: { type: "string", maxLength: MISSION_PANEL_PAGE_BYTES },
      }, required: ["index", "offset", "characters", "text"], additionalProperties: false } },
    }, required: ["digest", "total", "pieces"], additionalProperties: false },
  }, required: ["available"], additionalProperties: false,
} as const
