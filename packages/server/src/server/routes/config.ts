import { FastifyInstance } from "fastify"
import { z } from "zod"
import { ConfigStore } from "../../config/store"
import { BinaryRegistry } from "../../config/binaries"
import { ConfigFileSchema } from "../../config/schema"

interface RouteDeps {
  configStore: ConfigStore
  binaryRegistry: BinaryRegistry
}

const BinaryCreateSchema = z.object({
  path: z.string(),
  label: z.string().optional(),
  makeDefault: z.boolean().optional(),
})

const BinaryUpdateSchema = z.object({
  label: z.string().optional(),
  makeDefault: z.boolean().optional(),
})

const BinaryValidateSchema = z.object({
  path: z.string(),
})

export function registerConfigRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/config/app", async () => deps.configStore.get())

  app.put("/api/config/app", async (request) => {
    const body = ConfigFileSchema.parse(request.body ?? {})
    deps.configStore.replace(body)
    return deps.configStore.get()
  })

  app.get("/api/config/binaries", async () => {
    return { binaries: deps.binaryRegistry.list() }
  })

  app.post("/api/config/binaries", async (request, reply) => {
    const body = BinaryCreateSchema.parse(request.body ?? {})
    const binary = deps.binaryRegistry.create(body)
    reply.code(201)
    return { binary }
  })

  app.patch<{ Params: { id: string } }>("/api/config/binaries/:id", async (request) => {
    const body = BinaryUpdateSchema.parse(request.body ?? {})
    const binary = deps.binaryRegistry.update(request.params.id, body)
    return { binary }
  })

  app.delete<{ Params: { id: string } }>("/api/config/binaries/:id", async (request, reply) => {
    deps.binaryRegistry.remove(request.params.id)
    reply.code(204)
  })

  app.post("/api/config/binaries/validate", async (request) => {
    const body = BinaryValidateSchema.parse(request.body ?? {})
    return deps.binaryRegistry.validatePath(body.path)
  })
}
