import { createHash } from "node:crypto"
import { SessionLegacy } from "@opencode/schema/session-legacy"
import { z } from "zod"
import { canonicalContent } from "./revision"
import type { PruneRequest } from "./contract"

const partSchema = z.object({ type: z.enum(["text", "tool", "reasoning"]) }).passthrough()
export const assistantDataSchema = z.object({
  time: z.object({ completed: z.number().finite().positive() }).passthrough(),
  content: z.array(partSchema).max(100_001),
}).passthrough()

// Rows written before 2.1 keep their stored shape, which OpenCode upgrades before
// projecting (`state`/`providerState` -> `native`). Hash that projection, as the
// browser does, without rewriting stored parts.
export function revision(content: unknown): string {
  const projected = Array.isArray(content) ? SessionLegacy.message("assistant", { content }).content : content
  return createHash("sha256").update(canonicalContent(projected)).digest("hex")
}

export function previewContent(data: unknown) {
  const parsed = assistantDataSchema.safeParse(data)
  if (!parsed.success || parsed.data.content.some(part => part.type === "tool"
    && !["completed", "error"].includes(String((part.state as { status?: unknown } | undefined)?.status)))) {
    return { status: "blocked", reason: "not_deletable" } as const
  }
  const parts = parsed.data.content.flatMap((part, index) => part.type === "text" ? [] : [{
    index, type: part.type as "tool" | "reasoning", bytes: Buffer.byteLength(JSON.stringify(part)),
  }])
  return { status: "preview", revision: revision(parsed.data.content), liveMutation: false, parts } as const
}

export function planPrune(data: unknown, request: PruneRequest) {
  const preview = previewContent(data)
  if (preview.status === "blocked") return preview
  if (preview.revision !== request.revision) return { status: "blocked", reason: "conflict" } as const
  const allowed = new Set(preview.parts.map(part => part.index))
  if (request.indexes.some(index => !allowed.has(index))) return { status: "blocked", reason: "not_deletable" } as const
  const parsed = assistantDataSchema.parse(data)
  const selected = new Set(request.indexes)
  return { status: "planned", content: parsed.content.filter((_, index) => !selected.has(index)) } as const
}
