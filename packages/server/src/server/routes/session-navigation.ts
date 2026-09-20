import type { FastifyInstance } from "fastify"
import { PRUNING_RPC_ID } from "../../opencode/session-pruning/contract"
import { navigationWindowInputSchema, navigationWindowResultSchema, outlineInputSchema, outlineResultSchema, outlinePreviewInputSchema, outlinePreviewResultSchema } from "../../opencode/session-pruning/navigation-contract"
import { locationRequestOptions, readLocationRef, sameLocation } from "../../opencode/compatibility/location"
import type { HistoryRouteDeps } from "./session-history"

export function registerSessionNavigationRoutes(app: FastifyInstance, deps: Pick<HistoryRouteDeps, "workspaceManager">) {
  const inputs = { window: navigationWindowInputSchema, outline: outlineInputSchema, outlinePreview: outlinePreviewInputSchema }
  const outputs = { window: navigationWindowResultSchema, outline: outlineResultSchema, outlinePreview: outlinePreviewResultSchema }
  for (const method of ["window", "outline", "outlinePreview"] as const) {
    app.post<{ Params: { id: string } }>(`/api/workspaces/:id/session-history/${method}`, { bodyLimit: method === "outline" ? 96 * 1024 : 8192 }, async (request, reply) => {
      const parsed = inputs[method].safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: "Invalid history navigation request" })
      const client = await deps.workspaceManager.getSharedServiceClient()
      const session = await client.session.get({ sessionID: parsed.data.sessionID })
      const location = readLocationRef(session.location)
      if (!await deps.workspaceManager.ownsLocation(request.params.id, location, client)) return reply.code(403).send({ error: "Session does not belong to workspace" })
      const controller = new AbortController()
      const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
      reply.raw.once("close", abort)
      try {
        const response = await client.rpc.call({ rpcID: PRUNING_RPC_ID, method,
          input: JSON.parse(JSON.stringify(parsed.data)), location: { directory: location.directory } },
        { ...locationRequestOptions(location), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
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
