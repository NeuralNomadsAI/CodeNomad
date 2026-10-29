import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { PluginControlsError } from "../../opencode/plugin-controls"
import { IMAGE_MODEL_REF, type ImageSettings } from "../../opencode/image-settings"

const Location = z.object({ directory: z.string().trim().min(1).max(32_768) }).strict()
const Generation = z.union([z.boolean(), z.string().max(512).regex(IMAGE_MODEL_REF)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value))])
// One setting per write, so a failure never leaves the other half-applied.
const Mutation = z.union([
  z.object({ location: Location, generation: Generation }).strict(),
  z.object({ location: Location, mediaStorage: z.boolean() }).strict(),
])

export function registerImageSettingsRoutes(app: FastifyInstance, settings: Pick<ImageSettings, "read" | "update">) {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/image-settings", async (request, reply) => {
    const parsed = Location.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid image settings request" })
    try { return await settings.read(request.params.id, parsed.data) }
    catch (error) { return fail(error, reply) }
  })
  app.put<{ Params: { id: string } }>("/api/workspaces/:id/image-settings", async (request, reply) => {
    const parsed = Mutation.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid image settings request" })
    const { location, ...change } = parsed.data
    try {
      await settings.update(request.params.id, location, change)
      return reply.code(204).send()
    } catch (error) { return fail(error, reply) }
  })
}

function fail(error: unknown, reply: FastifyReply) {
  if (error instanceof PluginControlsError) {
    const status = { "not-found": 404, forbidden: 403, invalid: 422, conflict: 409, unavailable: 503 }[error.kind]
    return reply.code(status).send({ error: error.message })
  }
  // Upstream errors can contain credential-bearing requests; never serialize/log them.
  return reply.code(503).send({ error: "Image settings are unavailable" })
}
