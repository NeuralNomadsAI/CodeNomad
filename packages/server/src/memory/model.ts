import { z } from "zod"
import type { MemoryContent, MemoryEntry, MemoryErrorCode } from "./contract"
export type { MemoryScope, MemoryEntryType, MemoryContent, MemoryEntryHeader, MemoryEntry, MemoryErrorCode } from "./contract"
export const MEMORY_LIMITS = { global: 60, project: 200, title: 60, text: 2000, instructions: 8000 } as const

/** Safe business error; callers translate the code for the UI. Never attach raw Git/config errors. */
export class MemoryError extends Error {
  readonly name = "MemoryError"
  constructor(readonly code: MemoryErrorCode, message: string, readonly titles?: readonly string[]) {
    super(message)
  }
}

const boundedText = (limit: number) => z.string().refine(value => Array.from(value).length <= limit)
const content = z.object({
  title: boundedText(MEMORY_LIMITS.title).refine(value => Boolean(value.trim()) && !/[\x00-\x1f\x7f]/.test(value)),
  type: z.enum(["fact", "preference", "reference"]),
  text: boundedText(MEMORY_LIMITS.text),
}).strict()
const entry = content.extend({
  // IDs are also filenames: preserve a single, portable path segment.
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/).refine(value => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  sessionId: z.string().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
}).strict()

/** Lengths count Unicode code points; Markdown text is preserved byte-for-byte by validation. */
export function validateMemoryContent(value: unknown): MemoryContent {
  const result = content.safeParse(value)
  if (!result.success) throw new MemoryError("invalid", "Invalid memory content")
  return result.data
}

/** Storage readers use `malformed`; malformed entries must never become an empty scope. */
export function validateMemoryEntry(value: unknown, code: "invalid" | "malformed" = "invalid"): MemoryEntry {
  const result = entry.safeParse(value)
  if (!result.success) throw new MemoryError(code, "Invalid memory entry")
  return result.data
}
