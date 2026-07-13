import { FastifyInstance } from "fastify"
import { z } from "zod"
import { probeBinaryVersion } from "../../workspaces/spawn"
import type { SettingsService } from "../../settings/service"
import type { Logger } from "../../logger"
import { sanitizeConfigDoc, sanitizeConfigOwner } from "../../settings/public-config"

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

export function enforceSpeechCredentialPairing(body: unknown, currentSpeech?: unknown): unknown {
  if (!body || typeof body !== "object") return body
  const patch = { ...(body as Record<string, unknown>) }
  const speech = patch.speech
  if (!speech || typeof speech !== "object") return patch
  const speechPatch = { ...(speech as Record<string, unknown>) }
  const cur = (currentSpeech && typeof currentSpeech === "object") ? currentSpeech as Record<string, unknown> : {}
  const curSpeech = (cur.speech && typeof cur.speech === "object") ? cur.speech as Record<string, unknown> : cur

  if ("baseUrl" in speechPatch && !("apiKey" in speechPatch)) {
    if ((speechPatch.baseUrl ?? "") !== (curSpeech.baseUrl ?? "")) {
      speechPatch.apiKey = null
    }
  }
  for (const dir of ["stt", "tts"] as const) {
    if (dir in speechPatch) {
      const dirPatch = { ...(speechPatch[dir] as Record<string, unknown>) }
      if ("baseUrl" in dirPatch && !("apiKey" in dirPatch)) {
        const curDir = (curSpeech[dir] && typeof curSpeech[dir] === "object") ? curSpeech[dir] as Record<string, unknown> : {}
        if ((dirPatch.baseUrl ?? "") !== (curDir.baseUrl ?? "")) {
          dirPatch.apiKey = null
        }
        speechPatch[dir] = dirPatch
      }
    }
  }
  patch.speech = speechPatch
  return patch
}

export function registerSettingsRoutes(app: FastifyInstance, deps: RouteDeps) {
  // Full-document access
  app.get("/api/storage/config", async () => sanitizeConfigDoc(deps.settings.getDoc("config")))
  app.patch("/api/storage/config", async (request, reply) => {
    try {
      const processed = enforceSpeechCredentialPairing(request.body ?? {})
      return sanitizeConfigDoc(deps.settings.mergePatchDoc("config", processed))
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Invalid patch" }
    }
  })

  app.get<{ Params: { owner: string } }>("/api/storage/config/:owner", async (request) => {
    return sanitizeConfigOwner(request.params.owner, deps.settings.getOwner("config", request.params.owner))
  })

  app.patch<{ Params: { owner: string } }>("/api/storage/config/:owner", async (request, reply) => {
    try {
      const currentOwner = request.params.owner === "server"
        ? deps.settings.getOwner("config", "server")
        : undefined
      const processed = request.params.owner === "server"
        ? enforceSpeechCredentialPairing(request.body ?? {}, currentOwner)
        : request.body ?? {}
      return sanitizeConfigOwner(
        request.params.owner,
        deps.settings.mergePatchOwner("config", request.params.owner, processed),
      )
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
