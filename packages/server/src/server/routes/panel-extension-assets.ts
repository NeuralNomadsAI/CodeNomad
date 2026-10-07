import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { PanelExtensionStore } from "../../panel-extensions/store"
import { PanelExtensionError } from "../../panel-extensions/archive"
import { PRUNING_RPC_ID } from "../../opencode/session-pruning/contract"
import { assetsInputSchema, assetsResultSchema, assetReadInputSchema, assetReadResultSchema } from "../../opencode/session-pruning/assets-contract"
import { locationRequestOptions, readLocationRef } from "../../opencode/compatibility/location"

export function registerPanelExtensionAssetRoutes(app: FastifyInstance, deps: {
  store: PanelExtensionStore; workspaceManager: Pick<WorkspaceManager, "getSharedServiceClient" | "ownsLocation">
}) {
  const authority = { instanceId: z.string().min(1).max(256), digest: z.string().regex(/^[a-f0-9]{64}$/) }
  const idSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9-]{1,39}$/) }).strict()
  for (const method of ["assets", "assetRead"] as const) {
    app.post(`/api/panel-extensions/:id/${method}`, { bodyLimit: 8192 }, async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      try {
        const { id } = idSchema.parse(request.params)
        const schema = (method === "assets" ? assetsInputSchema : assetReadInputSchema).extend(authority).strict()
        const { instanceId, digest, ...input } = schema.parse(request.body)
        await deps.store.authorizeAssets(id, digest)
        const client = await deps.workspaceManager.getSharedServiceClient()
        const session = await client.session.get({ sessionID: input.sessionID })
        if (!await deps.workspaceManager.ownsLocation(instanceId, session.location, client)) return reply.code(403).send({ error: "Unowned session" })
        const location = readLocationRef(session.location)
        const result = await client.rpc.call({ rpcID: PRUNING_RPC_ID, method, input,
          location: { directory: location.directory } }, { ...locationRequestOptions(location), signal: AbortSignal.timeout(15_000) })
        const parsed = (method === "assets" ? assetsResultSchema : assetReadResultSchema).safeParse(result.output)
        if (!parsed.success) throw new PanelExtensionError("unavailable")
        const output = parsed.data
        // Revocation, replacement and moves during IO must fence the response too.
        await deps.store.authorizeAssets(id, digest)
        const current = await client.session.get({ sessionID: input.sessionID })
        if (JSON.stringify(readLocationRef(current.location)) !== JSON.stringify(location)
          || !await deps.workspaceManager.ownsLocation(instanceId, current.location, client)) return reply.code(409).send({ error: "Session moved" })
        if (output.status === "blocked") return reply.code(503).send({ error: "Assets unavailable" })
        return output
      } catch (error) {
        const code = error instanceof z.ZodError ? 400 : error instanceof PanelExtensionError
          ? { missing: 404, disabled: 403, conflict: 409, invalid: 400, limit: 413, unavailable: 503 }[error.code] : 503
        return reply.code(code).send({ error: "Assets unavailable" })
      }
    })
  }
}
