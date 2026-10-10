import { FastifyInstance } from "fastify"
import { z } from "zod"
import type { BinaryValidationResult } from "../../api-types"
import { probeOpenCodeBinary } from "../../workspaces/spawn"
import type { SettingsService } from "../../settings/service"
import type { Logger } from "../../logger"
import { sanitizeConfigDoc, sanitizeConfigOwner } from "../../settings/public-config"
import { resolveDefaultInstallation } from "../../opencode-update/shared-installation"
import { applyConditionalMissionPreferences, MissionPreferenceConflictError } from "../../settings/mission-preference-condition"
import { SettingsReadError } from "../../settings/yaml-doc-store"

interface RouteDeps {
  settings: SettingsService
  logger: Logger
}

const ValidateBinarySchema = z.object({
  path: z.string(),
})

function validateBinaryPath(binaryPath: string): Promise<BinaryValidationResult> {
  return probeOpenCodeBinary(binaryPath)
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
      let body = request.body ?? {}
      if (body && typeof body === "object" && "server" in body) {
        const bodyObj = { ...(body as Record<string, unknown>) }
        const serverPatch = bodyObj.server
        if (serverPatch && typeof serverPatch === "object") {
          const currentServer = deps.settings.getOwner("config", "server")
          bodyObj.server = enforceSpeechCredentialPairing(serverPatch, currentServer)
        }
        body = bodyObj
      }
      return sanitizeConfigDoc(deps.settings.mergePatchDoc("config", body))
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Invalid patch" }
    }
  })

  app.get<{ Params: { owner: string } }>("/api/storage/config/:owner", async (request, reply) => {
    try {
      const owner = request.params.owner
      return sanitizeConfigOwner(owner, owner === "ui"
        ? deps.settings.getRawConfigOwner(owner)
        : deps.settings.getOwner("config", owner))
    } catch (error) {
      if (!(error instanceof SettingsReadError)) throw error
      reply.code(503)
      return { error: error.message }
    }
  })

  app.patch<{ Params: { owner: string }; Querystring: { conditional?: unknown } }>("/api/storage/config/:owner", async (request, reply) => {
    try {
      if (Object.prototype.hasOwnProperty.call(request.query, "conditional")) {
        if (request.query.conditional !== "missions-v1") throw new Error("Unknown conditional patch mode")
        return sanitizeConfigOwner(
          request.params.owner,
          applyConditionalMissionPreferences(deps.settings, request.params.owner, request.body),
        )
      }
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
      reply.code(error instanceof MissionPreferenceConflictError ? 409 : error instanceof SettingsReadError ? 503 : 400)
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
      return validateBinaryPath(body.path === "opencode2" || body.path === "opencode" ? resolveDefaultInstallation().path : body.path)
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to validate binary")
      reply.code(400)
      return { valid: false, error: error instanceof Error ? error.message : "Invalid request" }
    }
  })
}
