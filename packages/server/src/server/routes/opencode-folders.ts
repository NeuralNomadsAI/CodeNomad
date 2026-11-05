// prototype-1236: "Browse" on an explicit OpenCode server lists its folders through the server's
// single shared connection. Like opening a server project, it is available to paired devices.
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { OpenCodeServerConnections } from "../../opencode/servers/connections"
import { ServerConnectionError } from "../../opencode/servers/connections"
import { listServerFolders, parseServerFolderPath, ServerFolderPathError } from "../../opencode/servers/folders"
import { LOCAL_SHARED_SERVER_ID } from "../../opencode/servers/types"
import { requestAdmission } from "../request-admission"

const QuerySchema = z.object({ serverId: z.string().min(1).max(200), path: z.string().max(4_096).optional() }).strict()

export function registerOpenCodeFolderRoutes(app: FastifyInstance, deps: { connections(): OpenCodeServerConnections }) {
  app.get("/api/opencode-folders", async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success || parsed.data.serverId === LOCAL_SHARED_SERVER_ID) return reply.code(400).send({ code: "invalid_request" })
    let path: string | undefined
    try { path = parseServerFolderPath(parsed.data.path) } catch (error) {
      if (error instanceof ServerFolderPathError) return reply.code(400).send({ code: "invalid_path" })
      throw error
    }
    const observer = requestAdmission(request, reply)
    try {
      const connection = await deps.connections().connect(parsed.data.serverId)
      return await listServerFolders((input, options) => connection.client.file.list(input, options) as never, path, observer.signal)
    } catch (error) {
      if (observer.signal.aborted || reply.raw.destroyed) { reply.hijack(); return }
      if (error instanceof ServerConnectionError) {
        return reply.code(error.code === "unknown_server" ? 404 : 503).type("text/plain").send(error.code)
      }
      return reply.code(502).type("text/plain").send("unreachable")
    } finally { observer.dispose() }
  })
}
