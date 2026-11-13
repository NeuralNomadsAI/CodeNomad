import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { PanelExtensionStore } from "../../panel-extensions/store"
import { PanelExtensionError } from "../../panel-extensions/archive"
import { PRUNING_RPC_ID } from "../../opencode/session-pruning/contract"
import { assetsInputSchema, assetsResultSchema, assetReadInputSchema, assetReadResultSchema } from "../../opencode/session-pruning/assets-contract"
import { locationRequestOptions, readLocationRef } from "../../opencode/compatibility/location"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { captureDisplayIdentities } from "../../workspaces/worktree-display-identity"

class SessionMoved extends Error {}

export function registerPanelExtensionAssetRoutes(app: FastifyInstance, deps: {
  store: PanelExtensionStore; workspaceManager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getWorktreeIdentityForPath" | "getSharedServiceConnection" | "ownsLocation" | "desktopPluginsReady">
  worktreeDeletionFence: WorktreeDeletionFence
}) {
  const authority = { instanceId: z.string().min(1).max(256), digest: z.string().regex(/^[a-f0-9]{64}$/) }
  const idSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9-]{1,39}$/) }).strict()
  for (const method of ["assets", "assetRead"] as const) {
    app.post(`/api/panel-extensions/:id/${method}`, { bodyLimit: 8192 }, async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      const deadlineAt = Date.now() + 15_000
      const abandoned = new AbortController()
      const abort = () => { if (!reply.raw.writableEnded) abandoned.abort() }
      reply.raw.once("close", abort)
      const signal = AbortSignal.any([abandoned.signal, AbortSignal.timeout(15_000)])
      try {
        const { id } = idSchema.parse(request.params)
        const schema = (method === "assets" ? assetsInputSchema : assetReadInputSchema).extend(authority).strict()
        const { instanceId, digest, ...input } = schema.parse(request.body)
        const manager = deps.workspaceManager
        const workspace = manager.get(instanceId), base = manager.getServiceLocation(instanceId)
        const fences = [deps.worktreeDeletionFence.captureDisplay(base ? [base.directory] : [])]
        await deps.store.authorize(id, digest, "session.assets.read")
        signal.throwIfAborted()
        const connection = await deps.workspaceManager.getSharedServiceConnection(instanceId)
        if (!connection || !workspace || !base) throw new PanelExtensionError("unavailable")
        const current = () => {
          signal.throwIfAborted(); connection.assertCurrent()
          if (manager.get(instanceId) !== workspace || manager.getServiceLocation(instanceId) !== base || fences.some(check => !check())) throw new PanelExtensionError("unavailable")
        }
        current()
        const client = connection.client
        const session = await client.session.get({ sessionID: input.sessionID }, { signal })
        current()
        const location = readLocationRef(session.location)
        if (!await manager.ownsLocation(instanceId, location, client, { signal })) return reply.code(403).send({ error: "Unowned session" })
        current()
        fences.push((await captureDisplayIdentities(deps.worktreeDeletionFence, manager, instanceId, [location.directory]))!)
        current()
        const revalidate = async () => {
          current()
          const latest = await client.session.get({ sessionID: input.sessionID }, { signal })
          current()
          if (JSON.stringify(readLocationRef(latest.location)) !== JSON.stringify(location)
            || !await manager.ownsLocation(instanceId, latest.location, client, { signal })) throw new SessionMoved()
          current()
          await deps.store.authorize(id, digest, "session.assets.read")
          current()
        }
        await manager.desktopPluginsReady({ connection, location: { directory: location.directory }, signal, deadlineAt, assertCurrent: current })
        await revalidate()
        current()
        const result = await client.rpc.call({ rpcID: PRUNING_RPC_ID, method, input,
          location: { directory: location.directory } }, { ...locationRequestOptions(location), signal })
        current()
        const parsed = (method === "assets" ? assetsResultSchema : assetReadResultSchema).safeParse(result.output)
        if (!parsed.success) throw new PanelExtensionError("unavailable")
        const output = parsed.data
        // Revocation, replacement and moves during IO must fence the response too.
        await revalidate()
        current()
        if (output.status === "blocked") return reply.code(503).send({ error: "Assets unavailable" })
        return output
      } catch (error) {
        if (error instanceof SessionMoved) return reply.code(409).send({ error: "Session moved" })
        const code = error instanceof z.ZodError ? 400 : error instanceof PanelExtensionError
          ? { missing: 404, disabled: 403, conflict: 409, invalid: 400, limit: 413, unavailable: 503 }[error.code] : 503
        return reply.code(code).send({ error: "Assets unavailable" })
      } finally { reply.raw.removeListener("close", abort) }
    })
  }
}
