import { FastifyInstance } from "fastify"
import { z } from "zod"
import { readFile, writeFile } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import os from "os"
import { probeBinaryVersion } from "../../workspaces/spawn"
import type { SettingsService } from "../../settings/service"
import type { Logger } from "../../logger"
import { sanitizeConfigDoc, sanitizeConfigOwner } from "../../settings/public-config"
import { stripJsonc } from "../../config/jsonc"

interface RouteDeps {
  settings: SettingsService
  logger: Logger
}

const ValidateBinarySchema = z.object({
  path: z.string(),
})

const PluginEntrySchema = z.string().min(1)
const UpdatePluginConfigSchema = z.object({
  plugins: z.array(PluginEntrySchema),
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

function safeJsonParse(raw: string): Record<string, unknown> | null {
  try {
    const cleaned = stripJsonc(raw).replace(/,\s*}/g, "}").replace(/,\s*\]/g, "]")
    const parsed = JSON.parse(cleaned)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

type PluginEntry = { spec: string; enabled: boolean }

function normalizePluginEntry(entry: unknown): PluginEntry | null {
  if (typeof entry === "string" && entry.trim().length > 0) {
    return { spec: entry.trim(), enabled: true }
  }
  if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && entry[0].trim().length > 0) {
    const opts = entry[1] as Record<string, unknown> | null | undefined
    const enabled = opts && typeof opts === "object" && "enabled" in opts ? opts.enabled !== false : true
    return { spec: entry[0].trim(), enabled }
  }
  return null
}

function readPluginsFromConfig(config: Record<string, unknown>): PluginEntry[] {
  const raw = config.plugin
  if (!Array.isArray(raw)) return []
  return raw.map(normalizePluginEntry).filter((entry): entry is PluginEntry => entry !== null)
}

function getGlobalConfigPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "opencode.jsonc")
}

async function readGlobalConfigPlugins(): Promise<PluginEntry[]> {
  const configPath = getGlobalConfigPath()
  if (!existsSync(configPath)) return []
  try {
    const raw = await readFile(configPath, "utf-8")
    const config = safeJsonParse(raw)
    if (!config) return []
    return readPluginsFromConfig(config)
  } catch {
    return []
  }
}

async function writeGlobalConfigPlugins(entries: PluginEntry[]): Promise<void> {
  const configPath = getGlobalConfigPath()
  let config: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, "utf-8")
      config = safeJsonParse(raw) ?? {}
    } catch { /* use empty config */ }
  }

  const serialized: unknown[] = entries.map((entry) => {
    if (entry.enabled) return entry.spec
    return [entry.spec, { enabled: false }]
  })

  if (serialized.length === 0) {
    delete config.plugin
  } else {
    config.plugin = serialized
  }

  config["$schema"] = config["$schema"] ?? "https://opencode.ai/config.json"
  const dir = path.dirname(configPath)
  const { mkdir } = await import("fs/promises")
  await mkdir(dir, { recursive: true })
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
}

function isValidPluginSpec(spec: string): boolean {
  return (
    spec.startsWith("npm:") ||
    spec.startsWith("file://") ||
    spec.startsWith("https://") ||
    spec.startsWith("http://") ||
    spec.startsWith("/") ||
    spec.startsWith(".")
  )
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

  // Plugin config management — reads/writes the global opencode.jsonc plugin array
  app.get("/api/opencode-plugin-config", async () => {
    try {
      const plugins = await readGlobalConfigPlugins()
      return { plugins: plugins.map((p) => ({ spec: p.spec, enabled: p.enabled })) }
    } catch {
      return { plugins: [] }
    }
  })

  app.put("/api/opencode-plugin-config", async (request, reply) => {
    try {
      const body = UpdatePluginConfigSchema.parse(request.body ?? {})
      for (const spec of body.plugins) {
        if (!isValidPluginSpec(spec.trim())) {
          reply.code(400)
          return { error: `Invalid plugin spec: "${spec}". Must start with npm:, file://, https://, /, or .` }
        }
      }
      const entries: PluginEntry[] = body.plugins.map((spec) => ({ spec: spec.trim(), enabled: true }))
      await writeGlobalConfigPlugins(entries)

      // Also update CodeNomad server config so workspaces pick up plugins on launch
      const rawConfig = deps.settings.getOwner("config", "server") ?? {}
      const existingEnvVars =
        typeof rawConfig === "object" && !Array.isArray(rawConfig) && rawConfig !== null
          ? (rawConfig as Record<string, unknown>).environmentVariables
          : undefined
      const envVars =
        typeof existingEnvVars === "object" && !Array.isArray(existingEnvVars) && existingEnvVars !== null
          ? { ...(existingEnvVars as Record<string, unknown>) }
          : {}
      envVars.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: entries.map((p) => p.spec) })
      if (entries.length === 0) {
        delete envVars.OPENCODE_CONFIG_CONTENT
      }
      deps.settings.mergePatchOwner("config", "server", { environmentVariables: envVars })

      return { plugins: entries.map((p) => ({ spec: p.spec, enabled: p.enabled })) }
    } catch (error) {
      if (error instanceof z.ZodError) {
        reply.code(400)
        return { error: error.issues.map((i) => i.message).join("; ") }
      }
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Invalid plugin config" }
    }
  })
}
