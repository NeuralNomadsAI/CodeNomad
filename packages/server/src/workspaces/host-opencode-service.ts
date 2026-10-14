import { createHash } from "node:crypto"
import path from "node:path"

import { OpenCodeCliService, type OpenCodeCliServiceDependencies } from "./opencode-cli-service"
import { buildSpawnSpec } from "./spawn"

const DEFAULT_TIMEOUT_MS = 30_000

export interface HostOpenCodeServiceOptions {
  binary: string
  platform?: NodeJS.Platform
  startupEnvironment?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export class HostOpenCodeService extends OpenCodeCliService {
  constructor(
    options: HostOpenCodeServiceOptions,
    dependencies: Partial<OpenCodeCliServiceDependencies> = {},
  ) {
    const platform = options.platform ?? process.platform
    const startupEnvironment = daemonProcessEnvironment(options.startupEnvironment)
    super({
      label: "Host",
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      command: (args, start) => buildSpawnSpec(options.binary, args, {
        platform,
        ...(start ? { env: startupEnvironment } : {}),
      }),
    }, dependencies)
  }
}

/** Never inherited by the shared daemon: its storage roots, and the desktop host's
 * profile/config scope and backend hand-offs. The daemon outlives and is shared by every
 * profile; its shells must not pin a desktop launched from them to this backend's profile. */
const DAEMON_EXCLUDED_ENVIRONMENT = [
  "OPENCODE_DB",
  "XDG_STATE_HOME",
  "CODENOMAD_PROFILE",
  "CODENOMAD_UPDATE_CHANNEL",
  "CODENOMAD_PROFILE_CONFIG_IDENTITY",
  "CODENOMAD_DESKTOP_PROFILE",
  "CODENOMAD_PROFILE_SELECTION_CLEANUP",
  "CODENOMAD_PROFILE_SELECTION_ANSWER",
  "CLI_CONFIG",
  "CODENOMAD_NATIVE_PARENT",
  "ELECTRON_RUN_AS_NODE",
]

export function daemonProcessEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...overrides }
  for (const key of Object.keys(environment)) {
    if (DAEMON_EXCLUDED_ENVIRONMENT.includes(key.toUpperCase())) delete environment[key]
  }
  return environment
}

export function hostOpenCodeServiceIdentity(options: HostOpenCodeServiceOptions): string {
  const platform = options.platform ?? process.platform
  const binary = platform === "win32"
    ? path.win32.normalize(options.binary).toLowerCase()
    : path.normalize(options.binary)
  return `host:${platform}:${binary}:env:${startupEnvironmentHash(options.startupEnvironment, platform)}`
}

export function startupEnvironmentHash(
  startupEnvironment: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const environment = Object.entries(startupEnvironment ?? {})
    .map(([key, value]) => [platform === "win32" ? key.toUpperCase() : key, value ?? ""] as const)
    .sort(([left], [right]) => left.localeCompare(right))
  return createHash("sha256").update(JSON.stringify(environment)).digest("hex")
}
