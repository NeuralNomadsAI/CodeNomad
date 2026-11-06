import { z } from "zod"
import type { MemoryContext, MemoryOperation } from "./contract"
export type { MemoryOperation, MemoryContext, MemorySettings, MemoryVersionedEntry, MemoryUIEntry, MemoryListEntry, MemoryUIListResult, MemoryResult, MemoryApiError } from "./contract"

const scope = z.enum(["global", "project"])
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const content = z.object({ title: z.string(), type: z.enum(["fact", "preference", "reference"]), text: z.string() }).strict()
export const MemoryOperationSchema: z.ZodType<MemoryOperation> = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), scope }).strict(),
  z.object({ action: z.literal("read"), scope, query: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal("save"), scope, content, id: id.optional(), revision: revision.optional() }).strict(),
  z.object({ action: z.literal("delete"), scope, id, revision }).strict(),
])
export const MemoryContextSchema: z.ZodType<MemoryContext> = z.object({ workspaceId: z.string().min(1).max(200), directory: z.string().min(1).max(4096).optional() }).strict()
