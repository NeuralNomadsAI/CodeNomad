/**
 * Opt-in request header of transcript page reads (native message list, history
 * window): large tool images arrive as session-media paths instead of inline
 * base64, and the renderer loads each one when it is shown. Shared with the UI.
 */
export const DEFERRED_MEDIA_HEADER = "x-codenomad-media"
export const DEFERRED_MEDIA_VALUE = "deferred"

/** `/api/workspaces/<id>/session-media/<session>/<message>/<part>/<index>/<sha256>` */
export function isSessionMediaPath(value: string): boolean {
  return /^\/api\/workspaces\/[^/?#]+\/session-media\/[^/?#]+\/[^/?#]+\/\d{1,6}\/\d{1,6}\/[a-f0-9]{64}$/.test(value)
}
