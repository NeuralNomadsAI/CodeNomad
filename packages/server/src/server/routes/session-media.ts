import type { FastifyInstance } from "fastify"
import { OpenCode } from "@opencode/client"
import { readLocationRef, sameLocation } from "../../opencode/compatibility/location"
import { isRenderableToolImage, mediaDigest, toolFile } from "../../opencode/session-media"
import { parseSessionMediaPath } from "../../opencode/session-media-contract"
import { embeddedImage } from "../../opencode/embedded-asset"
import { awaitSessionMedia, createSessionMediaFetch } from "../../opencode/session-media-fetch"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import type { WorkspaceManager } from "../../workspaces/manager"

type MediaParams = { id: string; sessionId: string; messageId: string; part: string; index: string; digest: string }

/**
 * Serves one tool image that a transcript page deferred (`opencode/session-media.ts`),
 * read from the owned session's native message and pinned by its digest.
 */
export function registerSessionMediaRoutes(app: FastifyInstance, deps: { workspaceManager: Pick<WorkspaceManager,
  "captureWorkspaceOperation" | "getSharedServiceConnection" | "ownsLocation"> }) {
  app.get<{ Params: MediaParams }>("/api/workspaces/:id/session-media/:sessionId/:messageId/:part/:index/:digest", async (request, reply) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    reply.raw.once("close", abort)
    const deadline = setTimeout(() => controller.abort(new DOMException("Media deadline", "TimeoutError")), 30_000)
    let operation: ReturnType<typeof deps.workspaceManager.captureWorkspaceOperation>
    let connection: ServiceConnection | undefined
    let signal = controller.signal
    const current = () => {
      if (reply.raw.destroyed || reply.raw.closed || request.raw.aborted || request.raw.socket?.destroyed) controller.abort()
      signal.throwIfAborted()
      operation?.current()
      connection?.assertCurrent()
    }
    const wait = async <T>(pending: Promise<T>) => {
      current()
      const value = await awaitSessionMedia(pending, signal)
      current()
      return value
    }
    const sendError = (code: number, error: string) => { current(); return reply.code(code).send({ error }) }
    try {
      current()
      const reference = parseSessionMediaPath(request.url)
      if (!reference) return sendError(400, "Invalid media reference")
      const { workspaceId: id, sessionId, messageId, digest, part, index } = reference
      operation = deps.workspaceManager.captureWorkspaceOperation(id)
      if (!operation) return sendError(404, "Media not found")
      signal = AbortSignal.any([controller.signal, operation.signal])
      current()
      connection = await wait(deps.workspaceManager.getSharedServiceConnection(id))
      current()
      if (!connection) return sendError(502, "Media unavailable")
      const client = OpenCode.make({ baseUrl: connection.endpoint.url, fetch: createSessionMediaFetch(connection, signal, current) })
      current()
      const session = await wait(client.session.get({ sessionID: sessionId }, { signal }))
      current()
      const location = readLocationRef(session.location)
      if (session.id !== sessionId || !await wait(deps.workspaceManager.ownsLocation(id, location, client, { signal, strict: true, media: { current } }))) {
        return sendError(403, "Session does not belong to workspace")
      }
      current()
      const message = await wait(client.session.message.get({ sessionID: sessionId, messageID: messageId }, { signal }))
      // As for history reads: a session that moved during the read is refused,
      // and messages at or after an undo boundary are no longer its history.
      current()
      const latest = await wait(client.session.get({ sessionID: sessionId }, { signal }))
      current()
      if (latest.id !== sessionId || !sameLocation(location, readLocationRef(latest.location))
        || !await wait(deps.workspaceManager.ownsLocation(id, latest.location, client, { signal, strict: true, media: { current } }))) {
        return sendError(409, "Session location changed")
      }
      current()
      const boundary = (latest.revert as { messageID?: unknown } | null | undefined)?.messageID
      const file = toolFile(message, part, index)
      if (message.id !== messageId || (typeof boundary === "string" && messageId >= boundary) || !isRenderableToolImage(file)) {
        return sendError(404, "Media not found")
      }
      current()
      if (mediaDigest(file.uri) !== digest) return sendError(404, "Media not found")
      current()
      const image = embeddedImage(file)
      current()
      if (!image) return sendError(404, "Media not found")
      current()
      return reply
        .header("content-type", image.mime)
        // The digest in the path pins these bytes.
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .send(image.bytes)
    } catch {
      try { return sendError(502, "Media unavailable") }
      catch { reply.hijack(); reply.raw.destroy(); return reply }
    } finally { clearTimeout(deadline); reply.raw.removeListener("close", abort) }
  })
}
