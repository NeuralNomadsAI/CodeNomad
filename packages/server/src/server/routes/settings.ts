import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify"
import { z } from "zod"
import type { BinaryValidationResult } from "../../api-types"
import { probeOpenCodeBinary } from "../../workspaces/spawn"
import { SESSION_FAVORITES_OWNER, SESSION_PERMISSION_BLOCKS_OWNER, type SettingsService } from "../../settings/service"
import type { Logger } from "../../logger"
import { sanitizeConfigDoc, sanitizeConfigOwner } from "../../settings/public-config"
import { resolveDefaultInstallation } from "../../opencode-update/shared-installation"
import { applyConditionalMissionPreferences, MissionPreferenceConflictError } from "../../settings/mission-preference-condition"
import { SettingsReadError } from "../../settings/yaml-doc-store"
import { HostOnlySettingError, hostOnlyServerCheck } from "../../settings/host-only-settings"
import { isLocalRequest } from "../../remote-control/request-origin"
import { isPlainObject } from "../../settings/merge-patch"
import type { BackendCallerGuard } from "../../codenomad-servers/ui-caller"
import { NEW_CONVERSATION_PERMISSIONS, newConversationMode } from "../../permissions/session-mode"

const privateStateOwners = [SESSION_FAVORITES_OWNER, SESSION_PERMISSION_BLOCKS_OWNER]

function checkConversationDefault(before: Record<string, unknown>, after: Record<string, unknown>) {
  const mode = (document: Record<string, unknown>) =>
    (document.ui as { settings?: Record<string, unknown> } | undefined)?.settings?.[NEW_CONVERSATION_PERMISSIONS]
  const next = mode(after)
  if (next !== mode(before)) newConversationMode(next)
}

interface RouteDeps {
  settings: SettingsService
  logger: Logger
  /** An installed login start follows an explicit executable change; its failure never refuses the save. */
  refreshLoginStart?: () => Promise<void>
  withConfigLock?: <T>(action: () => T) => Promise<T>
  guardServerProfiles?: BackendCallerGuard
  principalSignal?: (request: FastifyRequest) => AbortSignal | undefined
}

const ValidateBinarySchema = z.object({
  path: z.string(),
})

const configPatchOptions: RouteShorthandOptions = {
  errorHandler(error, _request, reply) {
    // JSON syntax errors can quote the submitted credentials before the handler runs.
    if (error instanceof SyntaxError && error.statusCode === 400) {
      return reply.code(400).send({ error: "Invalid settings patch" })
    }
    throw error
  },
}

function validateBinaryPath(binaryPath: string): Promise<BinaryValidationResult> {
  return probeOpenCodeBinary(binaryPath)
}

export function enforceSpeechCredentialPairing(body: unknown, currentSpeech?: unknown): unknown {
  if (!isPlainObject(body)) return body
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

async function refreshLoginStart(deps: RouteDeps) {
  await deps.refreshLoginStart?.().catch(error => deps.logger.warn?.({ err: error }, "Failed to update the OpenCode login start"))
}

export function registerSettingsRoutes(app: FastifyInstance, deps: RouteDeps) {
  const withConfigLock = deps.withConfigLock ?? (async <T>(action: () => T): Promise<T> => action())
  // Full-document access
  app.get("/api/storage/config", async () => sanitizeConfigDoc(deps.settings.getDoc("config")))
  app.patch("/api/storage/config", configPatchOptions, async (request, reply) => {
    try {
      let body = request.body ?? {}
      const saved = await withConfigLock(() => {
        if (body && typeof body === "object" && "server" in body) {
          const bodyObj = { ...(body as Record<string, unknown>) }
          const serverPatch = bodyObj.server
          if (isPlainObject(serverPatch)) {
            const currentServer = deps.settings.getRawConfigOwner("server")
            bodyObj.server = enforceSpeechCredentialPairing(serverPatch, currentServer)
          }
          body = bodyObj
        }
        return deps.settings.mergePatchDoc("config", body, (before, after) => {
          hostOnlyServerCheck(isLocalRequest(request))?.(before, after)
          checkConversationDefault(before, after)
        })
      })
      if (body && typeof body === "object" && "server" in body && body.server && typeof body.server === "object"
        && "opencodeBinary" in body.server) await refreshLoginStart(deps)
      return sanitizeConfigDoc(saved)
    } catch (error) {
      reply.code(error instanceof HostOnlySettingError ? 403 : error instanceof SettingsReadError ? 503 : 400)
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

  app.patch<{ Params: { owner: string }; Querystring: { conditional?: unknown } }>("/api/storage/config/:owner", configPatchOptions, async (request, reply) => {
    try {
      if (Object.prototype.hasOwnProperty.call(request.query, "conditional")) {
        if (request.query.conditional !== "missions-v1") throw new Error("Unknown conditional patch mode")
        return sanitizeConfigOwner(
          request.params.owner,
          await withConfigLock(() => applyConditionalMissionPreferences(deps.settings, request.params.owner, request.body)),
        )
      }
      const saved = await withConfigLock(() => {
        const currentOwner = request.params.owner === "server"
          ? deps.settings.getRawConfigOwner("server")
          : undefined
        const processed = request.params.owner === "server"
          ? enforceSpeechCredentialPairing(request.body ?? {}, currentOwner)
          : request.body ?? {}
        return deps.settings.mergePatchOwner("config", request.params.owner, processed, (before, after) => {
          hostOnlyServerCheck(isLocalRequest(request))?.(before, after)
          if (request.params.owner === "ui") checkConversationDefault(before, after)
        })
      })
      if (request.params.owner === "server" && request.body && typeof request.body === "object" && "opencodeBinary" in request.body)
        await refreshLoginStart(deps)
      return sanitizeConfigOwner(request.params.owner, saved)
    } catch (error) {
      reply.code(error instanceof MissionPreferenceConflictError ? 409 : error instanceof SettingsReadError ? 503
        : error instanceof HostOnlySettingError ? 403 : 400)
      return { error: error instanceof Error ? error.message : "Invalid patch" }
    }
  })

  const publicState = () => {
    const doc = { ...deps.settings.getDoc("state") }
    for (const owner of privateStateOwners) delete doc[owner]
    return doc
  }
  app.get("/api/storage/state", async () => publicState())
  app.patch("/api/storage/state", async (request, reply) => {
    try {
      deps.principalSignal?.(request)?.throwIfAborted()
      const ui = isPlainObject(request.body) ? request.body.ui : undefined
      if (ui !== undefined && (!isPlainObject(ui) || Object.hasOwn(ui, "remoteServers"))
        && deps.guardServerProfiles?.(request, reply)) return
      const patch = request.body
      if (patch && typeof patch === "object" && privateStateOwners.some(owner => Object.hasOwn(patch, owner))) {
        return reply.code(403).send()
      }
      deps.settings.mergePatchDoc("state", request.body ?? {})
      return publicState()
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Invalid patch" }
    }
  })

  app.get<{ Params: { owner: string } }>("/api/storage/state/:owner", async (request, reply) => {
    if (privateStateOwners.includes(request.params.owner)) return reply.code(403).send()
    return deps.settings.getOwner("state", request.params.owner)
  })

  app.patch<{ Params: { owner: string } }>("/api/storage/state/:owner", async (request, reply) => {
    if (privateStateOwners.includes(request.params.owner)) return reply.code(403).send()
    try {
      deps.principalSignal?.(request)?.throwIfAborted()
      if (request.params.owner === "ui" && isPlainObject(request.body) && Object.hasOwn(request.body, "remoteServers")
        && deps.guardServerProfiles?.(request, reply)) return
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
