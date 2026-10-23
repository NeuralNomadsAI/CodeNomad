import { createHash } from "node:crypto"
import { DEFERRED_MEDIA_HEADER, DEFERRED_MEDIA_VALUE } from "./session-media-contract"

export { DEFERRED_MEDIA_HEADER } from "./session-media-contract"
/** Data URIs up to this length stay inline. */
export const INLINE_MEDIA_LIMIT = 32 * 1024

type ToolImage = { type: "file"; mime: string; uri: string }

export function wantsDeferredMedia(headers: Record<string, string | string[] | undefined>): boolean {
  return headers[DEFERRED_MEDIA_HEADER] === DEFERRED_MEDIA_VALUE
}

export function mediaDigest(uri: string): string {
  return createHash("sha256").update(uri).digest("hex")
}

/** An image the renderer shows inline: a base64 data URI of its declared image type. */
export function isRenderableToolImage(value: unknown): value is ToolImage {
  const file = value as Partial<ToolImage> | null
  if (file?.type !== "file" || typeof file.mime !== "string" || !/^image\/[\w.+-]+$/i.test(file.mime) || typeof file.uri !== "string") return false
  const header = `data:${file.mime.toLowerCase()};base64,`
  return file.uri.slice(0, header.length).toLowerCase() === header
}

export function sessionMediaPath(target: { workspaceId: string; sessionId: string; messageId: string; part: number; index: number; digest: string }): string {
  const segment = encodeURIComponent
  return `/api/workspaces/${segment(target.workspaceId)}/session-media/${segment(target.sessionId)}/${segment(target.messageId)}/${target.part}/${target.index}/${target.digest}`
}

/** A tool result file of a native assistant message, addressed by content positions. */
export function toolFile(message: unknown, part: number, index: number): unknown {
  const native = message as { type?: unknown; content?: unknown } | null
  if (native?.type !== "assistant" || !Array.isArray(native.content)) return undefined
  const tool = native.content[part] as { type?: unknown; state?: { content?: unknown } } | undefined
  return tool?.type === "tool" && Array.isArray(tool.state?.content) ? tool.state.content[index] : undefined
}

/**
 * Replaces, in place, tool images whose data URI exceeds INLINE_MEDIA_LIMIT in
 * native messages with their session-media path. The digest pins the exact bytes.
 */
export function deferToolMedia(messages: unknown, scope: { workspaceId: string; sessionId: string }): void {
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (message?.type !== "assistant" || typeof message.id !== "string" || !Array.isArray(message.content)) continue
    message.content.forEach((tool: { type?: unknown; state?: { content?: unknown } } | null, part: number) => {
      if (tool?.type !== "tool" || !Array.isArray(tool.state?.content)) return
      tool.state.content.forEach((file: unknown, index: number) => {
        if (!isRenderableToolImage(file) || file.uri.length <= INLINE_MEDIA_LIMIT) return
        file.uri = sessionMediaPath({ ...scope, messageId: message.id, part, index, digest: mediaDigest(file.uri) })
      })
    })
  }
}
