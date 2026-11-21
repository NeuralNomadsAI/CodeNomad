/**
 * Opt-in request header of transcript page reads (native message list, history
 * window): large tool images arrive as session-media paths instead of inline
 * base64, and the renderer loads each one when it is shown. Shared with the UI.
 */
export const DEFERRED_MEDIA_HEADER = "x-codenomad-media"
export const DEFERRED_MEDIA_VALUE = "deferred"
export const MESSAGE_LIMIT = 16 * 1024 * 1024

export type SessionMediaReference = { workspaceId: string; sessionId: string; messageId: string; part: number; index: number; digest: string }

/** Canonical wire reference; decoded IDs remain opaque, including backend-like prefixes. */
export function parseSessionMediaPath(value: string): SessionMediaReference | undefined {
  if (value.length > 4096) return undefined
  const match = /^\/api\/workspaces\/([^/?#]+)\/session-media\/([^/?#]+)\/([^/?#]+)\/(0|[1-9]\d{0,5})\/(0|[1-9]\d{0,5})\/([a-f0-9]{64})$/.exec(value)
  if (!match || Number(match[4]) > 100000 || Number(match[5]) > 100000) return undefined
  try {
    const ids = match.slice(1, 4).map(segment => {
      const id = decodeURIComponent(segment)
      if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) || encodeURIComponent(id) !== segment) throw new Error("Invalid media ID")
      return id
    })
    return { workspaceId: ids[0], sessionId: ids[1], messageId: ids[2], part: Number(match[4]), index: Number(match[5]), digest: match[6] }
  } catch { return undefined }
}

/** `/api/workspaces/<id>/session-media/<session>/<message>/<part>/<index>/<sha256>` */
export function isSessionMediaPath(value: string): boolean {
  return /^\/api\/workspaces\/[^/?#]+\/session-media\/[^/?#]+\/[^/?#]+\/\d{1,6}\/\d{1,6}\/[a-f0-9]{64}$/.test(value)
}
