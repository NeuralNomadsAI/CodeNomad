import type { FastifyInstance } from "fastify"
import { PRUNING_RPC_ID } from "../../opencode/session-pruning/contract"
import { navigationWindowInputSchema, navigationWindowResultSchema, outlineInputSchema, outlineLayoutResultSchema, outlinePreviewInputSchema, outlinePreviewResultSchema, sessionAttachmentInputSchema, sessionAttachmentResultSchema } from "../../opencode/session-pruning/navigation-contract"
import { locationRequestOptions, readLocationRef, sameLocation } from "../../opencode/compatibility/location"
import { deferToolMedia, wantsDeferredMedia } from "../../opencode/session-media"
import { awaitSessionMedia } from "../../opencode/session-media-fetch"
import type { HistoryRouteDeps } from "./session-history"
import { captureDisplayIdentities } from "../../workspaces/worktree-display-identity"
import { hasOnlyUserFileReferences, readInlineUserFile, USER_FILES_REFERENCE, userFileDigest } from "../../opencode/session-pruning/user-file-reference"

// The native SDK throws the declared RPC error body as the error's own fields.
function isMethodNotFound(error: unknown) {
  const body = error as { _tag?: unknown; type?: unknown } | null
  return body?._tag === "RpcError" && body.type === "rpc.method_not_found"
}
class NavigationConflict extends Error {}

export function registerSessionNavigationRoutes(app: FastifyInstance, deps: HistoryRouteDeps) {
  const inputs = { window: navigationWindowInputSchema, outline: outlineInputSchema, outlinePreview: outlinePreviewInputSchema,
    sessionAttachment: sessionAttachmentInputSchema }
  // The legacy outline (a plugin copy without `outlineLayout`) is a layout outline without layouts.
  const outputs = { window: navigationWindowResultSchema, outline: outlineLayoutResultSchema, outlinePreview: outlinePreviewResultSchema,
    sessionAttachment: sessionAttachmentResultSchema }
  for (const method of ["window", "outline", "outlinePreview", "sessionAttachment"] as const) {
    const attachment = method === "sessionAttachment"
    app.route<{ Params: { id: string; sessionID?: string; messageID?: string; fileIndex?: string; sha256?: string } }>({
      method: attachment ? "GET" : "POST",
      url: attachment ? "/api/workspaces/:id/session-attachment/:sessionID/:messageID/:fileIndex/:sha256" : `/api/workspaces/:id/session-history/${method}`,
      bodyLimit: method === "outline" ? 96 * 1024 : 8192,
      async handler(request, reply) {
      const { id, sessionID, messageID, fileIndex, sha256 } = request.params
      if (attachment && (![sessionID, messageID].every(value => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value))
        || !/^(?:0|[1-9][0-9]*)$/.test(fileIndex ?? "") || !/^[0-9a-f]{64}$/.test(sha256 ?? ""))) {
        return reply.code(400).send({ error: "Invalid attachment reference" })
      }
      const parsed = inputs[method].safeParse(attachment ? { sessionID, messageID, fileIndex: Number(fileIndex), sha256 } : request.body)
      if (!parsed.success) return reply.code(400).send({ error: "Invalid history navigation request" })
      const reference = method === "window" && request.headers["x-codenomad-user-files"] === USER_FILES_REFERENCE
      const manager = deps.workspaceManager
      const workspace = manager.get(id), base = manager.getServiceLocation(id)
      const fences = [deps.worktreeDeletionFence.captureDisplay(base ? [base.directory] : [])]
      const deadlineAt = Date.now() + 15_000
      const controller = new AbortController()
      const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
      reply.raw.once("close", abort)
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
         const wait = <T>(work: Promise<T>) => attachment ? awaitSessionMedia(work, signal) : work
         const connection = await wait(manager.getSharedServiceConnection(id))
        if (!connection || !workspace || !base) throw new Error("Workspace unavailable")
        const client = connection.client
        const current = () => {
          signal.throwIfAborted(); connection.assertCurrent()
          if (manager.get(id) !== workspace || manager.getServiceLocation(id) !== base || fences.some(check => !check())) throw new Error("History placement changed")
        }
        current()
        const session = await client.session.get({ sessionID: parsed.data.sessionID }, { signal })
        current()
        const location = readLocationRef(session.location)
         if (!await wait(manager.ownsLocation(id, location, client, { signal }))) return reply.code(403).send({ error: "Session does not belong to workspace" })
        current()
         fences.push((await wait(captureDisplayIdentities(deps.worktreeDeletionFence, manager, id, [location.directory])))!)
        current()
        const revalidate = async () => {
          current()
          const latest = await client.session.get({ sessionID: parsed.data.sessionID }, { signal })
          current()
           if (latest.id !== session.id || !sameLocation(location, readLocationRef(latest.location)) || latest.projectID !== session.projectID
             || JSON.stringify(latest.revert) !== JSON.stringify(session.revert)
             || !await wait(manager.ownsLocation(id, latest.location, client, { signal }))) throw new NavigationConflict("Session changed")
          current()
        }
        await manager.desktopPluginsReady({ connection, location: { directory: location.directory }, signal, deadlineAt, assertCurrent: current })
        await revalidate()
         const call = (rpcMethod: string, confirm = false) => {
          current()
          return client.rpc.call({ rpcID: PRUNING_RPC_ID, method: rpcMethod,
           input: confirm ? { ...parsed.data, confirm: true } : JSON.parse(JSON.stringify(parsed.data)), location: { directory: location.directory } },
        { ...locationRequestOptions(location), signal })
        }
        // The outline asks for layouts through the versioned method; a plugin
        // copy that predates it answers the legacy one.
        const response = method === "outline"
          ? await call("outlineLayout").catch(async (error: unknown) => { if (isMethodNotFound(error)) { await revalidate(); return call("outline") }; throw error })
          : await call(reference ? "windowUserFilesV1" : method)
        const output = outputs[method].parse(response.output)
        await revalidate()
        if (reference && output.status === "window"
          && (output.userFiles !== USER_FILES_REFERENCE || !output.messages.every(hasOnlyUserFileReferences))) {
          return { status: "blocked", reason: "unavailable" }
        }
        // A window is a transcript page: large tool images load on demand, as from the message list.
        if (method === "window" && output.status === "window" && wantsDeferredMedia(request.headers)) {
          deferToolMedia(output.messages, { workspaceId: request.params.id, sessionId: parsed.data.sessionID })
        }
        current()
        if (attachment) {
          if (output.status === "too_large") return reply.code(413).send({ error: "Attachment exceeds the size limit" })
          if (output.status !== "file") return reply.code(404).send({ error: "Attachment not found" })
           const bytes = readInlineUserFile(output.data)
           if (!Buffer.isBuffer(bytes) || userFileDigest(bytes) !== sha256) return reply.code(404).send({ error: "Attachment not found" })
           // Committing undo can delete the row and clear revert before the session is re-read.
           const confirmation = sessionAttachmentResultSchema.parse((await call("sessionAttachment", true)).output)
           if (confirmation.status !== "current") return reply.code(404).send({ error: "Attachment not found" })
           current()
          return reply.type("application/octet-stream").header("cache-control", "private, no-store")
            .header("content-disposition", "attachment").header("x-content-type-options", "nosniff").send(bytes)
        }
        return output
      } catch (error) {
        if (attachment) return error instanceof NavigationConflict ? reply.code(409).send({ error: "Session location changed" })
          : reply.code(404).send({ error: "Attachment not found" })
        if (error instanceof NavigationConflict) return { status: "blocked", reason: "conflict" }
        return { status: "blocked", reason: "unavailable" }
      } finally { reply.raw.removeListener("close", abort) }
    } })
  }
}
