import type { FastifyInstance } from "fastify"
import { readLocationRef, sameLocation } from "../../opencode/compatibility/location"
import { isRenderableToolImage, mediaDigest, toolFile } from "../../opencode/session-media"
import type { HistoryRouteDeps } from "./session-history"

type MediaParams = { id: string; sessionId: string; messageId: string; part: string; index: string; digest: string }

const position = (value: string) => (/^\d{1,6}$/.test(value) ? Number(value) : undefined)

/**
 * Serves one tool image that a transcript page deferred (`opencode/session-media.ts`),
 * read from the owned session's native message and pinned by its digest.
 */
export function registerSessionMediaRoutes(app: FastifyInstance, deps: Pick<HistoryRouteDeps, "workspaceManager">) {
  app.get<{ Params: MediaParams }>("/api/workspaces/:id/session-media/:sessionId/:messageId/:part/:index/:digest", async (request, reply) => {
    const { id, sessionId, messageId, digest } = request.params
    const part = position(request.params.part), index = position(request.params.index)
    if (part === undefined || index === undefined || !/^[a-f0-9]{64}$/.test(digest)) {
      return reply.code(400).send({ error: "Invalid media reference" })
    }
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.once("close", abort)
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
      const client = await deps.workspaceManager.getSharedServiceClient()
      const session = await client.session.get({ sessionID: sessionId }, { signal })
      if (!await deps.workspaceManager.ownsLocation(id, session.location, client)) {
        return reply.code(403).send({ error: "Session does not belong to workspace" })
      }
      const message = await client.session.message.get({ sessionID: sessionId, messageID: messageId }, { signal })
      // As for history reads: a session that moved during the read is refused,
      // and messages at or after an undo boundary are no longer its history.
      const current = await client.session.get({ sessionID: sessionId }, { signal })
      if (!sameLocation(readLocationRef(session.location), readLocationRef(current.location))
        || !await deps.workspaceManager.ownsLocation(id, current.location, client)) {
        return reply.code(409).send({ error: "Session location changed" })
      }
      const boundary = (current.revert as { messageID?: unknown } | null | undefined)?.messageID
      const file = toolFile(message, part, index)
      if ((typeof boundary === "string" && messageId >= boundary) || !isRenderableToolImage(file) || mediaDigest(file.uri) !== digest) {
        return reply.code(404).send({ error: "Media not found" })
      }
      return reply
        .header("content-type", file.mime.toLowerCase())
        // The digest in the path pins these bytes.
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .send(Buffer.from(file.uri.slice(file.uri.indexOf(",") + 1), "base64"))
    } catch {
      return reply.code(502).send({ error: "Media unavailable" })
    } finally { reply.raw.removeListener("close", abort) }
  })
}
