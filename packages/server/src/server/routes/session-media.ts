import type { FastifyInstance } from "fastify"
import { OpenCode } from "@opencode/client"
import { readLocationRef, sameLocation } from "../../opencode/compatibility/location"
import { isRenderableToolImage, mediaDigest, toolFile } from "../../opencode/session-media"
import type { WorkspaceManager } from "../../workspaces/manager"
import { WorkspaceCapabilityError } from "../../opencode/servers/capabilities"
import { boundedMediaFetch } from "../../opencode/session-media-fetch"
import { parseSessionMediaPath } from "../../opencode/session-media-contract"
import { isPassiveImageMime } from "../../opencode/embedded-asset"

type MediaParams = { id: string; sessionId: string; messageId: string; part: string; index: string; digest: string }

/**
 * Serves one tool image that a transcript page deferred (`opencode/session-media.ts`),
 * read from the owned session's native message and pinned by its digest.
 */
export function registerSessionMediaRoutes(app: FastifyInstance, deps: {
  workspaceManager: Pick<WorkspaceManager, "get" | "requireWorkspaceCapability" | "getSharedServiceConnection" | "ownsLocation">
}) {
  app.get<{ Params: MediaParams }>("/api/workspaces/:id/session-media/:sessionId/:messageId/:part/:index/:digest", async (request, reply) => {
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.once("close", abort)
    if (request.raw.aborted || reply.raw.destroyed) controller.abort()
    try {
      controller.signal.throwIfAborted()
      const { id, sessionId, messageId, digest } = request.params
      const reference = parseSessionMediaPath((request.raw.url ?? "").split("?")[0])
      if (!reference) {
        return reply.code(400).send({ error: "Invalid media reference" })
      }
      const { part, index } = reference
      const workspace = deps.workspaceManager.get(id)
      if (!workspace) return reply.code(404).send({ error: "Workspace not found" })
      const workspaceSignal = deps.workspaceManager.requireWorkspaceCapability(id, "media")
      const signal = AbortSignal.any([controller.signal, workspaceSignal, AbortSignal.timeout(30_000)])
      const explicit = workspace.binding?.serverId && workspace.binding.serverId !== "local-shared"
      signal.throwIfAborted()
      // Stop this observer's wait, leaving shared connection acquisition with its owner.
      const pending = deps.workspaceManager.getSharedServiceConnection(id)
      const connection = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason) }
        signal.addEventListener("abort", abort, { once: true })
        pending.then(value => {
          signal.removeEventListener("abort", abort)
          if (signal.aborted) reject(signal.reason)
          else resolve(value)
        }, error => { signal.removeEventListener("abort", abort); reject(error) })
        if (signal.aborted) abort()
      })
      if (!connection) return reply.code(503).send({ error: "Media unavailable" })
      const currentConnection = () => {
        signal.throwIfAborted()
        connection.assertCurrent()
        const current = deps.workspaceManager.get(id)
        if (explicit ? current?.binding !== workspace.binding : current !== workspace) throw new Error("Workspace changed")
        deps.workspaceManager.requireWorkspaceCapability(id, "media")
      }
      const client = OpenCode.make({ baseUrl: connection.endpoint.url, fetch: boundedMediaFetch(connection.fetch, signal, currentConnection) })
      currentConnection()
      const session = await client.session.get({ sessionID: sessionId }, { signal })
      currentConnection()
      const owns = async (value: typeof session) => {
        currentConnection()
        const owned = value.id === sessionId && (explicit
          ? value.location.directory === workspace.binding!.directory && readLocationRef(value.location).workspaceID === undefined
          : await deps.workspaceManager.ownsLocation(id, value.location, client, signal))
        currentConnection()
        return owned
      }
      if (!await owns(session)) {
        return reply.code(403).send({ error: "Session does not belong to workspace" })
      }
      const message = await client.session.message.get({ sessionID: sessionId, messageID: messageId }, { signal })
      currentConnection()
      // As for history reads: a session that moved during the read is refused,
      // and messages at or after an undo boundary are no longer its history.
      const current = await client.session.get({ sessionID: sessionId }, { signal })
      currentConnection()
      if (!sameLocation(readLocationRef(session.location), readLocationRef(current.location))
        || !await owns(current)) {
        return reply.code(409).send({ error: "Session location changed" })
      }
      const boundary = (current.revert as { messageID?: unknown } | null | undefined)?.messageID
      const file = toolFile(message, part, index)
      if (message.id !== messageId || (typeof boundary === "string" && messageId >= boundary) || !isRenderableToolImage(file)
        || (explicit && !isPassiveImageMime(file.mime)) || mediaDigest(file.uri) !== digest) {
        return reply.code(404).send({ error: "Media not found" })
      }
      currentConnection()
      return reply
        .header("content-type", file.mime.toLowerCase())
        // The digest in the path pins these bytes.
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .send(Buffer.from(file.uri.slice(file.uri.indexOf(",") + 1), "base64"))
    } catch (error) {
      if (controller.signal.aborted || reply.raw.destroyed) { reply.hijack(); return }
      if (error instanceof WorkspaceCapabilityError) return reply.code(403).send({ error: error.code, capability: error.capability, reason: error.reason })
      return reply.code(502).send({ error: "Media unavailable" })
    } finally { reply.raw.removeListener("close", abort) }
  })
}
