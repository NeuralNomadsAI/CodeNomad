import { FastifyInstance } from "fastify"
import { ServerMeta } from "../../api-types"

interface RouteDeps {
  serverMeta: ServerMeta
}

export function registerMetaRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/meta", async () => deps.serverMeta)
}
