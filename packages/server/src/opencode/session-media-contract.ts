/**
 * Opt-in request header of transcript page reads (native message list, history
 * window): large tool images arrive as session-media paths instead of inline
 * base64, and the renderer loads each one when it is shown. Shared with the UI.
 */
export const DEFERRED_MEDIA_HEADER = "x-codenomad-media"
export const DEFERRED_MEDIA_VALUE = "deferred"

/** Serialized message or whole decompressed media HTTP envelope, before parsing. */
export const MESSAGE_LIMIT = 16 * 1024 * 1024

/** `/api/workspaces/<id>/session-media/<session>/<message>/<part>/<index>/<sha256>` */
export function isSessionMediaPath(value: string): boolean {
  return /^\/api\/workspaces\/[^/?#]+\/session-media\/[^/?#]+\/[^/?#]+\/\d{1,6}\/\d{1,6}\/[a-f0-9]{64}$/.test(value)
}

/** Exact canonical native reference; encoded separators and alternate spellings fail closed. */
export function parseSessionMediaPath(value: string): { workspaceId: string; sessionId: string; messageId: string; part: number; index: number; digest: string } | undefined {
  if (value.length > 4096) return undefined
  const match = /^\/api\/workspaces\/([^/?#]+)\/session-media\/([^/?#]+)\/([^/?#]+)\/(0|[1-9]\d{0,5})\/(0|[1-9]\d{0,5})\/([a-f0-9]{64})$/.exec(value)
  if (!match) return undefined
  try {
    const ids = match.slice(1, 4).map(segment => {
      const id = decodeURIComponent(segment)
      if (!id || id === "." || id === ".." || /[\/%\\?#\x00-\x20\x7f]/.test(id) || encodeURIComponent(id) !== segment) throw new Error("Invalid media reference")
      return id
    })
    return { workspaceId: ids[0], sessionId: ids[1], messageId: ids[2], part: Number(match[4]), index: Number(match[5]), digest: match[6] }
  } catch { return undefined }
}
