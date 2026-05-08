import { spawnSync } from "child_process"
import { FastifyInstance, type FastifyRequest } from "fastify"
import { z } from "zod"
import type { ExecutionProfilePreviewResponse, ExecutionProfileTestResponse } from "../../api-types"
import { getOpencodeConfigDir } from "../../opencode-config.js"
import { buildLaunchPreview, formatCommandLine } from "../../workspaces/execution-launch"
import {
  OPENCODE_SERVER_BASE_URL_ENV,
  OPENCODE_SERVER_PASSWORD_ENV,
  OPENCODE_SERVER_USERNAME_ENV,
  resolveOpencodeServerAuth,
} from "../../workspaces/opencode-auth"
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

const ExecutionProfileSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    kind: z.literal("local"),
    binaryPath: z.string().trim().min(1),
  }),
  z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    kind: z.literal("wsl"),
    distro: z.string().trim().min(1),
    binaryPath: z.string().trim().min(1),
  }),
  z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    kind: z.literal("docker"),
    image: z.string().trim().min(1),
    workspaceMountPath: z.string().trim().min(1),
    configMountPath: z.string().trim().min(1),
    command: z.array(z.string().trim().min(1)).optional(),
    extraDockerArgs: z.array(z.string().trim().min(1)).optional(),
  }),
  z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    kind: z.literal("command"),
    executable: z.string().trim().min(1),
    args: z.array(z.string().trim().min(1)).optional(),
    cwdMode: z.enum(["workspace", "inherit"]).optional(),
  }),
])

const ExecutionProfilePreviewSchema = z.object({
  profile: ExecutionProfileSchema,
  workspacePath: z.string().trim().optional(),
})

const PREVIEW_SECRET_KEY = /(PASSWORD|TOKEN|SECRET|API[_-]?KEY)/i

function validateBinaryPath(binaryPath: string, options: { wslDistro?: string } = {}): { valid: boolean; version?: string; error?: string } {
  const result = probeBinaryVersion(binaryPath, options)
  return { valid: result.valid, version: result.version, error: result.error }
}

function validateDockerImage(image: string): { valid: boolean; version?: string; error?: string } {
  const docker = validateBinaryPath("docker")
  if (!docker.valid) {
    return docker
  }

  try {
    const result = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" })
    if (result.error) {
      return { valid: false, version: docker.version, error: result.error.message }
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.trim()
      const stdout = result.stdout?.trim()
      const combined = stderr || stdout
      const details = combined ? `: ${combined}` : ""
      return {
        valid: false,
        version: docker.version,
        error: `Docker image \"${image}\" is not available locally${details}`,
      }
    }

    return { valid: true, version: docker.version }
  } catch (error) {
    return { valid: false, version: docker.version, error: error instanceof Error ? error.message : String(error) }
  }
}

function normalizeRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }

  const output: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") {
      continue
    }
    const trimmed = entry.trim()
    if (trimmed) {
      output[key] = trimmed
    }
  }

  return output
}

function readConfiguredServerEnvironment(settings: SettingsService): Record<string, string> {
  const serverConfig = settings.getOwner("config", "server")
  return normalizeRecord((serverConfig as any)?.environmentVariables)
}

function readConfiguredLogLevel(settings: SettingsService): string {
  const serverConfig = settings.getOwner("config", "server")
  const logLevel = (serverConfig as any)?.logLevel
  return typeof logLevel === "string" && logLevel.trim() ? logLevel.toUpperCase() : "DEBUG"
}

function redactPreviewEnvironment(environment: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    redacted[key] = PREVIEW_SECRET_KEY.test(key) ? "REDACTED" : value
  }
  return redacted
}

function redactPreviewArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    const [key] = arg.split("=", 1)
    if (key && PREVIEW_SECRET_KEY.test(key)) {
      return arg.includes("=") ? `${key}=REDACTED` : "REDACTED"
    }

    const previous = args[index - 1]
    if ((previous === "-e" || previous === "--env") && PREVIEW_SECRET_KEY.test(key || arg)) {
      return arg.includes("=") ? `${key}=REDACTED` : arg
    }

    return arg
  })
}

function buildRequestBaseUrl(request: FastifyRequest): string {
  const host = request.headers.host?.trim()
  if (!host) {
    return "https://127.0.0.1:9898"
  }
  return `${request.protocol}://${host}`.replace(/\/+$/, "")
}

function buildExecutionProfilePreview(
  input: z.infer<typeof ExecutionProfilePreviewSchema>,
  options: { settings: SettingsService; requestBaseUrl: string },
): ExecutionProfilePreviewResponse {
  const workspacePath = input.workspacePath?.trim() || (process.platform === "win32" ? "C:/workspace" : "/workspace")
  const execution =
    input.profile.kind === "local"
      ? {
          kind: "local" as const,
          path: input.profile.binaryPath,
          label: input.profile.name,
        }
      : input.profile.kind === "wsl"
        ? {
            kind: "wsl" as const,
            path: input.profile.binaryPath,
            wslDistro: input.profile.distro,
            label: input.profile.name,
          }
        : input.profile.kind === "docker"
          ? {
              kind: "docker" as const,
              label: input.profile.name,
              image: input.profile.image,
              workspaceMountPath: input.profile.workspaceMountPath,
              configMountPath: input.profile.configMountPath,
              command: input.profile.command,
              extraDockerArgs: input.profile.extraDockerArgs,
            }
          : {
              kind: "command" as const,
              label: input.profile.name,
              executable: input.profile.executable,
              args: input.profile.args,
              cwdMode: input.profile.cwdMode,
            }

  const userEnvironment = readConfiguredServerEnvironment(options.settings)
  const previewInstanceId = "preview-instance"
  const normalizedBaseUrl = options.requestBaseUrl.replace(/\/+$/, "")
  const { username } = resolveOpencodeServerAuth({
    userEnvironment,
    processEnv: process.env,
  })

  const environment = {
    ...redactPreviewEnvironment(userEnvironment),
    OPENCODE_CONFIG_DIR: getOpencodeConfigDir(),
    CODENOMAD_INSTANCE_ID: previewInstanceId,
    CODENOMAD_BASE_URL: normalizedBaseUrl,
    [OPENCODE_SERVER_BASE_URL_ENV]: `${normalizedBaseUrl}/workspaces/${previewInstanceId}/worktrees/root/instance`,
    [OPENCODE_SERVER_USERNAME_ENV]: username,
    [OPENCODE_SERVER_PASSWORD_ENV]: "REDACTED",
  }

  const launch = buildLaunchPreview({
    execution,
    workspacePath,
    environment,
    logLevel: readConfiguredLogLevel(options.settings),
  })

  const redactedArgs = redactPreviewArgs(launch.args)

  return {
    command: launch.command,
    args: redactedArgs,
    commandLine: formatCommandLine(launch.command, redactedArgs),
    cwd: launch.cwd,
    environment: launch.environment ?? {},
  }
}

function testExecutionProfile(
  input: z.infer<typeof ExecutionProfilePreviewSchema>,
  options: { settings: SettingsService; requestBaseUrl: string },
): ExecutionProfileTestResponse {
  const preview = buildExecutionProfilePreview(input, options)
  const validation =
    input.profile.kind === "docker"
      ? validateDockerImage(input.profile.image)
      : input.profile.kind === "command"
        ? validateBinaryPath(input.profile.executable)
        : validateBinaryPath(input.profile.binaryPath, input.profile.kind === "wsl" ? { wslDistro: input.profile.distro } : {})

  return {
    ...preview,
    valid: validation.valid,
    version: validation.version,
    ...(validation.error ? { error: validation.error } : {}),
  }
}

export function registerSettingsRoutes(app: FastifyInstance, deps: RouteDeps) {
  // Full-document access
  app.get("/api/storage/config", async () => sanitizeConfigDoc(deps.settings.getDoc("config")))
  app.patch("/api/storage/config", async (request, reply) => {
    try {
      return sanitizeConfigDoc(deps.settings.mergePatchDoc("config", request.body ?? {}))
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
      return sanitizeConfigOwner(
        request.params.owner,
        deps.settings.mergePatchOwner("config", request.params.owner, request.body ?? {}),
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

  app.post("/api/storage/execution-profiles/preview", async (request, reply) => {
    try {
      const body = ExecutionProfilePreviewSchema.parse(request.body ?? {})
      return buildExecutionProfilePreview(body, {
        settings: deps.settings,
        requestBaseUrl: buildRequestBaseUrl(request),
      })
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to preview execution profile")
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Invalid request" }
    }
  })

  app.post("/api/storage/execution-profiles/test", async (request, reply) => {
    try {
      const body = ExecutionProfilePreviewSchema.parse(request.body ?? {})
      return testExecutionProfile(body, {
        settings: deps.settings,
        requestBaseUrl: buildRequestBaseUrl(request),
      })
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to test execution profile")
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Invalid request" }
    }
  })
}
