import type { FastifyInstance } from "fastify"
import { PRUNING_RPC_ID } from "../../opencode/session-pruning/contract"
import { navigationWindowInputSchema, navigationWindowResultSchema, outlineInputSchema, outlineLayoutResultSchema, outlinePreviewInputSchema, outlinePreviewResultSchema } from "../../opencode/session-pruning/navigation-contract"
import { locationRequestOptions, readLocationRef, sameLocation } from "../../opencode/compatibility/location"
import { deferToolMedia, wantsDeferredMedia } from "../../opencode/session-media"
import type { HistoryRouteDeps } from "./session-history"
import { captureDisplayIdentities } from "../../workspaces/worktree-display-identity"

// The native SDK throws the declared RPC error body as the error's own fields.
function isMethodNotFound(error: unknown) {
  const body = error as { _tag?: unknown; type?: unknown } | null
  return body?._tag === "RpcError" && body.type === "rpc.method_not_found"
}
class NavigationConflict extends Error {}

export function registerSessionNavigationRoutes(app: FastifyInstance, deps: HistoryRouteDeps) {
  const inputs = { window: navigationWindowInputSchema, outline: outlineInputSchema, outlinePreview: outlinePreviewInputSchema }
  // The legacy outline (a plugin copy without `outlineLayout`) is a layout outline without layouts.
  const outputs = { window: navigationWindowResultSchema, outline: outlineLayoutResultSchema, outlinePreview: outlinePreviewResultSchema }
  for (const method of ["window", "outline", "outlinePreview"] as const) {
    app.post<{ Params: { id: string } }>(`/api/workspaces/:id/session-history/${method}`, { bodyLimit: method === "outline" ? 96 * 1024 : 8192 }, async (request, reply) => {
      const parsed = inputs[method].safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: "Invalid history navigation request" })
      const manager = deps.workspaceManager, id = request.params.id
      const workspace = manager.get(id), base = manager.getServiceLocation(id)
      const fences = [deps.worktreeDeletionFence.captureDisplay(base ? [base.directory] : [])]
      const deadlineAt = Date.now() + 15_000
      const controller = new AbortController()
      const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
      reply.raw.once("close", abort)
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
        const connection = await manager.getSharedServiceConnection(id)
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
        if (!await manager.ownsLocation(id, location, client, { signal })) return reply.code(403).send({ error: "Session does not belong to workspace" })
        current()
        fences.push((await captureDisplayIdentities(deps.worktreeDeletionFence, manager, id, [location.directory]))!)
        current()
        const revalidate = async () => {
          current()
          const latest = await client.session.get({ sessionID: parsed.data.sessionID }, { signal })
          current()
          if (!sameLocation(location, readLocationRef(latest.location)) || latest.projectID !== session.projectID
            || JSON.stringify(latest.revert) !== JSON.stringify(session.revert) || !await manager.ownsLocation(id, latest.location, client, { signal })) throw new NavigationConflict("Session changed")
          current()
        }
        await manager.desktopPluginsReady({ connection, location: { directory: location.directory }, signal, deadlineAt, assertCurrent: current })
        await revalidate()
        const call = (rpcMethod: string) => {
          current()
          return client.rpc.call({ rpcID: PRUNING_RPC_ID, method: rpcMethod,
          input: JSON.parse(JSON.stringify(parsed.data)), location: { directory: location.directory } },
        { ...locationRequestOptions(location), signal })
        }
        // The outline asks for layouts through the versioned method; a plugin
        // copy that predates it answers the legacy one.
        const response = method === "outline"
          ? await call("outlineLayout").catch(async (error: unknown) => { if (isMethodNotFound(error)) { await revalidate(); return call("outline") }; throw error })
          : await call(method)
        const output = outputs[method].parse(response.output)
        await revalidate()
        // A window is a transcript page: large tool images load on demand, as from the message list.
        if (method === "window" && output.status === "window" && wantsDeferredMedia(request.headers)) {
          deferToolMedia(output.messages, { workspaceId: request.params.id, sessionId: parsed.data.sessionID })
        }
        current()
        return output
      } catch (error) {
        if (error instanceof NavigationConflict) return { status: "blocked", reason: "conflict" }
        return { status: "blocked", reason: "unavailable" }
      } finally { reply.raw.removeListener("close", abort) }
    })
  }
}
