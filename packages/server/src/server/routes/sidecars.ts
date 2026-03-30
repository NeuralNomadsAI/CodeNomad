import { FastifyInstance } from "fastify"
import { z } from "zod"
import type { SideCarManager } from "../../sidecars/manager"

interface RouteDeps {
  sidecarManager: SideCarManager
}

const SideCarCreateSchema = z.object({
  kind: z.literal("port").default("port"),
  name: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  insecure: z.boolean().default(false),
  prefixMode: z.enum(["strip", "preserve"]).default("strip"),
})

const SideCarUpdateSchema = SideCarCreateSchema.omit({ kind: true }).partial().refine((value) => Object.keys(value).length > 0, {
  message: "At least one field is required",
})

export function registerSideCarRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/sidecars", async () => {
    return { sidecars: await deps.sidecarManager.list() }
  })

  app.post("/api/sidecars", async (request, reply) => {
    try {
      const body = SideCarCreateSchema.parse(request.body ?? {})
      const sidecar = await deps.sidecarManager.create(body)
      reply.code(201)
      return sidecar
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to create SideCar" }
    }
  })

  app.put<{ Params: { id: string } }>("/api/sidecars/:id", async (request, reply) => {
    try {
      const body = SideCarUpdateSchema.parse(request.body ?? {})
      return await deps.sidecarManager.update(request.params.id, body)
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to update SideCar" }
    }
  })

  app.delete<{ Params: { id: string } }>("/api/sidecars/:id", async (request, reply) => {
    const removed = await deps.sidecarManager.delete(request.params.id)
    if (!removed) {
      reply.code(404)
      return { error: "SideCar not found" }
    }
    reply.code(204)
  })
}
