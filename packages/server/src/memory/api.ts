import { z } from "zod"
import type { MemoryEntry, MemoryEntryHeader, MemoryErrorCode } from "./model"

const scope = z.enum(["global", "project"])
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const content = z.object({ title: z.string(), type: z.enum(["fact", "preference", "reference"]), text: z.string() }).strict()
export const MemoryOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), scope }).strict(),
  z.object({ action: z.literal("read"), scope, query: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal("save"), scope, content, id: id.optional(), revision: revision.optional() }).strict(),
  z.object({ action: z.literal("delete"), scope, id, revision }).strict(),
])
export const MemoryContextSchema = z.object({ workspaceId: z.string().min(1).max(200), directory: z.string().min(1).max(4096).optional() }).strict()
export type MemoryOperation = z.infer<typeof MemoryOperationSchema>
export type MemoryContext = z.infer<typeof MemoryContextSchema>
export interface MemorySettings { enabled: boolean }
export type MemoryVersionedEntry = MemoryEntry & { revision: string }
export type MemoryUIEntry = MemoryVersionedEntry & { flagged: boolean; warning?: "suspected_injection" }
export type MemoryListEntry = MemoryEntryHeader & { revision: string }
export type MemoryResult = { entries: MemoryUIEntry[] | MemoryListEntry[] }
  | { entry: MemoryUIEntry | MemoryVersionedEntry | null }
  | { id: string; revision: string; flagged: boolean } | { deleted: true }
export interface MemoryApiError { code: MemoryErrorCode; error: string; titles?: readonly string[] }
