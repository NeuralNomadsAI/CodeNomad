import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AuthManager } from "../../auth/manager"
import type { NativeBrowserAttachments } from "../../opencode/native-browser/attachments"

const HoldSchema = z.object({ workspaceId: z.string().min(1).max(256), sessionId: z.string().min(1).max(256) })
const HoldId = z.string().uuid()

/** A local view holds its session's attachment to OpenCode's browser tools while it shows the session. */
export function registerNativeBrowserRoutes(app: FastifyInstance, deps: { attachments: NativeBrowserAttachments; authManager: Pick<AuthManager, "isLoopbackRequest"> }) {
  app.put<{ Params: { holdId: string } }>("/api/native-browser/holds/:holdId", async (request, reply) => {
    // The preview it drives is on this host's screen: remote clients do not hold it.
    if (!deps.authManager.isLoopbackRequest(request)) return reply.code(403).send({ error: "Local views only" })
    const holdId = HoldId.safeParse(request.params.holdId), body = HoldSchema.safeParse(request.body)
    if (!holdId.success || !body.success) return reply.code(400).send({ error: "Invalid browser hold" })
    try { deps.attachments.hold(holdId.data, body.data.workspaceId, body.data.sessionId) }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }) }
    return reply.code(204).send()
  })
  app.delete<{ Params: { holdId: string } }>("/api/native-browser/holds/:holdId", async (request, reply) => {
    if (!deps.authManager.isLoopbackRequest(request)) return reply.code(403).send({ error: "Local views only" })
    deps.attachments.release(request.params.holdId)
    return reply.code(204).send()
  })
}
