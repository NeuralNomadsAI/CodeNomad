import type { FastifyInstance } from "fastify"
import { PRUNING_RPC_ID } from "../../opencode/session-pruning/contract"
import { navigationWindowInputSchema, navigationWindowResultSchema, outlineInputSchema, outlineLayoutResultSchema, outlinePreviewInputSchema, outlinePreviewResultSchema } from "../../opencode/session-pruning/navigation-contract"
import { locationRequestOptions, readLocationRef, sameLocation } from "../../opencode/compatibility/location"
import type { HistoryRouteDeps } from "./session-history"

// The native SDK throws the declared RPC error body as the error's own fields.
function isMethodNotFound(error: unknown) {
  const body = error as { _tag?: unknown; type?: unknown } | null
  return body?._tag === "RpcError" && body.type === "rpc.method_not_found"
}

export function registerSessionNavigationRoutes(app: FastifyInstance, deps: Pick<HistoryRouteDeps, "workspaceManager">) {
  const inputs = { window: navigationWindowInputSchema, outline: outlineInputSchema, outlinePreview: outlinePreviewInputSchema }
  // The legacy outline (a plugin copy without `outlineLayout`) is a layout outline without layouts.
  const outputs = { window: navigationWindowResultSchema, outline: outlineLayoutResultSchema, outlinePreview: outlinePreviewResultSchema }
  for (const method of ["window", "outline", "outlinePreview"] as const) {
    app.post<{ Params: { id: string } }>(`/api/workspaces/:id/session-history/${method}`, { bodyLimit: method === "outline" ? 96 * 1024 : 8192 }, async (request, reply) => {
      const parsed = inputs[method].safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: "Invalid history navigation request" })
      const client = await deps.workspaceManager.getSharedServiceClient()
      // The first timeline/history read after a backend start would otherwise
      // reach the plugin before it observed this backend and be refused.
      await deps.workspaceManager.desktopPluginsReady()
      const session = await client.session.get({ sessionID: parsed.data.sessionID })
      const location = readLocationRef(session.location)
      if (!await deps.workspaceManager.ownsLocation(request.params.id, location, client)) return reply.code(403).send({ error: "Session does not belong to workspace" })
      const controller = new AbortController()
      const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
      reply.raw.once("close", abort)
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
        const call = (rpcMethod: string) => client.rpc.call({ rpcID: PRUNING_RPC_ID, method: rpcMethod,
          input: JSON.parse(JSON.stringify(parsed.data)), location: { directory: location.directory } },
        { ...locationRequestOptions(location), signal })
        // The outline asks for layouts through the versioned method; a plugin
        // copy that predates it answers the legacy one.
        const response = method === "outline"
          ? await call("outlineLayout").catch((error: unknown) => { if (isMethodNotFound(error)) return call("outline"); throw error })
          : await call(method)
        const output = outputs[method].parse(response.output)
        const current = await client.session.get({ sessionID: parsed.data.sessionID })
        if (!sameLocation(location, readLocationRef(current.location)) || current.projectID !== session.projectID
          || JSON.stringify(current.revert) !== JSON.stringify(session.revert)
          || !await deps.workspaceManager.ownsLocation(request.params.id, current.location, client)) {
          return { status: "blocked", reason: "conflict" }
        }
        return output
      } catch {
        return { status: "blocked", reason: "unavailable" }
      } finally { reply.raw.removeListener("close", abort) }
    })
  }
}
