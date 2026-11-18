import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import { locationRequestOptions, readLocationRef } from "../../opencode/compatibility/location"
import { GOAL_RPC_ID, goalStateSchema, type SessionGoalResponse } from "../../opencode/goal-contract"
import { awaitNativePlugin } from "../../opencode/plugin-activation"
import { sameLocation } from "../../opencode/compatibility/location"

export interface SessionGoalRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "getSharedServiceConnection" | "ownsLocation" | "get" | "getServiceLocation">
}

const sessionIdSchema = z.string().min(4).max(512).regex(/^ses[A-Za-z0-9_-]*$/)
const outputSchema = goalStateSchema.nullable()
const READ_TIMEOUT_MS = 8_000

// Method absence is definitive only after the exact plugin is active.
function isUnsupported(error: unknown): boolean {
  const body = error as { _tag?: unknown; type?: unknown } | null
  return body?._tag === "RpcError" && body.type === "rpc.method_not_found"
}

/**
 * Reads a Session's `/goal` through the fixed `opencode.goal` `get` method, in the
 * Session's own Location, after checking that the Session belongs to the workspace.
 * The instance proxy refuses plugin RPCs, so this is the UI's only read path.
 */
export function registerSessionGoalRoute(app: FastifyInstance, deps: SessionGoalRouteDeps): void {
  app.get<{ Params: { id: string; sessionId: string } }>("/api/workspaces/:id/sessions/:sessionId/goal", async (request, reply) => {
    reply.header("cache-control", "no-store")
    const parsed = sessionIdSchema.safeParse(request.params.sessionId)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid session" })
    const sessionID = parsed.data
    const manager = deps.workspaceManager
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.once("close", abort)
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
      const workspace = manager.get(request.params.id), base = manager.getServiceLocation(request.params.id)
      if (!workspace || !base) return reply.code(403).send({ error: "Session does not belong to workspace" })
      const connection = await manager.getSharedServiceConnection(request.params.id)
      if (!connection) return { status: "unavailable" }
      const client = connection.client
      const current = () => {
        signal.throwIfAborted(); connection.assertCurrent()
        if (manager.get(request.params.id) !== workspace || manager.getServiceLocation(request.params.id) !== base) throw new Error("Goal owner changed")
      }
      current()
      const session = await client.session.get({ sessionID }, { signal }).catch(() => undefined)
      current()
      if (!session) return reply.code(404).send({ error: "Session not found" })
      const location = readLocationRef(session.location)
      if (!await manager.ownsLocation(request.params.id, location, client, { signal })) return reply.code(403).send({ error: "Session does not belong to workspace" })
      let result: SessionGoalResponse
      try {
        const revalidate = async () => {
          current()
          const latest = await client.session.get({ sessionID }, { signal })
          current()
          if (!sameLocation(location, readLocationRef(latest.location)) || latest.projectID !== session.projectID
            || !await manager.ownsLocation(request.params.id, latest.location, client, { signal })) throw new Error("Goal session moved")
          current()
        }
        await awaitNativePlugin(client, GOAL_RPC_ID, { directory: location.directory }, signal, current)
        await revalidate()
        const response = await client.rpc.call({ rpcID: GOAL_RPC_ID, method: "get", input: { sessionID }, location: { directory: location.directory } },
          { ...locationRequestOptions(location), signal })
        await revalidate()
        const output = outputSchema.safeParse(response.output)
        result = output.success ? { status: "goal", goal: output.data } : { status: "unavailable" }
      } catch (error) {
        result = isUnsupported(error) ? { status: "unsupported" } : { status: "unavailable" }
      }
      return result
    } catch { return { status: "unavailable" } }
    finally { reply.raw.removeListener("close", abort) }
  })
}
