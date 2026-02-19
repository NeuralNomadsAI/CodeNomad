import { FastifyInstance } from "fastify"
import { z } from "zod"
import { probeBinaryVersion } from "../../workspaces/runtime"
import type { SettingsService } from "../../settings/service"
import type { Logger } from "../../logger"

interface RouteDeps {
  settings: SettingsService
  logger: Logger
}

const ValidateBinarySchema = z.object({
  path: z.string(),
})

function validateBinaryPath(binaryPath: string): { valid: boolean; version?: string; error?: string } {
  const result = probeBinaryVersion(binaryPath)
  return { valid: result.valid, version: result.version, error: result.error }
}

export function registerSettingsRoutes(app: FastifyInstance, deps: RouteDeps) {
  // Full-document access
  app.get("/api/storage/config", async () => deps.settings.getDoc("config"))
  app.patch("/api/storage/config", async (request, reply) => {
    try {
      return deps.settings.mergePatchDoc("config", request.body ?? {})
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Invalid patch" }
    }
  })

  app.get<{ Params: { owner: string } }>("/api/storage/config/:owner", async (request) => {
    return deps.settings.getOwner("config", request.params.owner)
  })

  app.patch<{ Params: { owner: string } }>("/api/storage/config/:owner", async (request, reply) => {
    try {
      return deps.settings.mergePatchOwner("config", request.params.owner, request.body ?? {})
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Invalid patch" }
    }
  })

  app.get("/api/storage/state", async () => deps.settings.getDoc("state"))
  app.patch("/api/storage/state", async (request, reply) => {
    try {
      return deps.settings.mergePatchDoc("state", request.body ?? {})
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Invalid patch" }
    }
  })

  app.get<{ Params: { owner: string } }>("/api/storage/state/:owner", async (request) => {
    return deps.settings.getOwner("state", request.params.owner)
  })

  app.patch<{ Params: { owner: string } }>("/api/storage/state/:owner", async (request, reply) => {
    try {
      return deps.settings.mergePatchOwner("state", request.params.owner, request.body ?? {})
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Invalid patch" }
    }
  })

  // Binary validation helper (used by UI when adding binaries)
  app.post("/api/storage/binaries/validate", async (request, reply) => {
    try {
      const body = ValidateBinarySchema.parse(request.body ?? {})
      return validateBinaryPath(body.path)
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to validate binary")
      reply.code(400)
      return { valid: false, error: error instanceof Error ? error.message : "Invalid request" }
    }
  })
}
