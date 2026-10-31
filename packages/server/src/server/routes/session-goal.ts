import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import { locationRequestOptions, readLocationRef } from "../../opencode/compatibility/location"
import { GOAL_RPC_ID, goalStateSchema, type SessionGoalResponse } from "../../opencode/goal-contract"

export interface SessionGoalRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "getSharedServiceClient" | "ownsLocation">
}

const sessionIdSchema = z.string().min(4).max(512).regex(/^ses[A-Za-z0-9_-]*$/)
const outputSchema = goalStateSchema.nullable()
const READ_TIMEOUT_MS = 8_000

// The native SDK throws a declared RPC error with its body's fields: a runtime
// without the goal plugin has no registration (or no such method).
function isUnsupported(error: unknown): boolean {
  const body = error as { _tag?: unknown; type?: unknown } | null
  return body?._tag === "RpcError" && (body.type === "rpc.unavailable" || body.type === "rpc.method_not_found")
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
      const client = await manager.getSharedServiceClient()
      const session = await client.session.get({ sessionID }, { signal }).catch(() => undefined)
      if (!session) return reply.code(404).send({ error: "Session not found" })
      const location = readLocationRef(session.location)
      if (!await manager.ownsLocation(request.params.id, location, client, signal)) return reply.code(403).send({ error: "Session does not belong to workspace" })
      let result: SessionGoalResponse
      try {
        const response = await client.rpc.call({ rpcID: GOAL_RPC_ID, method: "get", input: { sessionID }, location: { directory: location.directory } },
          { ...locationRequestOptions(location), signal })
        const output = outputSchema.safeParse(response.output)
        result = output.success ? { status: "goal", goal: output.data } : { status: "unavailable" }
      } catch (error) {
        result = isUnsupported(error) ? { status: "unsupported" } : { status: "unavailable" }
      }
      return result
    } finally { reply.raw.removeListener("close", abort) }
  })
}
