import { URL } from "url"
import type { ResolvedBinary } from "../settings/binaries"
import { buildSpawnSpec, WSL_PID_MARKER } from "./spawn"

const DOCKER_HOST_ALIAS = "host.docker.internal"
const DOCKER_CA_CERT_PATH = "/tmp/codenomad-node-extra-ca.pem"

export interface LaunchCommandSpec {
  command: string
  args: string[]
  cwd?: string
  environment?: Record<string, string>
  wslDistro?: string
}

interface BuildLaunchCommandParams {
  execution: ResolvedBinary
  workspacePath: string
  environment: Record<string, string>
  logLevel: string
}

export function buildLaunchCommand(params: BuildLaunchCommandParams): LaunchCommandSpec {
  const openCodeArgs = ["serve", "--port", "0", "--print-logs", "--log-level", params.logLevel]

  if (params.execution.kind === "docker") {
    return buildDockerLaunchCommand(params.execution, params.workspacePath, params.environment, openCodeArgs)
  }

  if (params.execution.kind === "command") {
    return {
      command: params.execution.executable,
      args: [...(params.execution.args ?? []), ...openCodeArgs],
      cwd: params.execution.cwdMode === "inherit" ? undefined : params.workspacePath,
      environment: params.environment,
    }
  }

  return {
    command: params.execution.path,
    args: openCodeArgs,
    cwd: params.workspacePath,
    environment: params.environment,
    wslDistro: params.execution.kind === "wsl" ? params.execution.wslDistro : undefined,
  }
}

export function buildLaunchPreview(params: BuildLaunchCommandParams): LaunchCommandSpec {
  const launch = buildLaunchCommand(params)
  const explicitEnvironment = launch.environment ?? {}
  const mergedEnvironment = { ...process.env, ...explicitEnvironment }
  const spawnSpec = buildSpawnSpec(launch.command, launch.args, {
    cwd: launch.cwd,
    env: mergedEnvironment,
    propagateEnvKeys: Object.keys(explicitEnvironment),
    wslPidMarker: WSL_PID_MARKER,
    wslDistro: launch.wslDistro,
  })

  return {
    command: spawnSpec.command,
    args: spawnSpec.args,
    cwd: spawnSpec.cwd,
    environment: collectPreviewEnvironment(explicitEnvironment, mergedEnvironment, spawnSpec.env),
  }
}

export function formatCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(formatCommandToken).join(" ")
}

function buildDockerLaunchCommand(
  execution: Extract<ResolvedBinary, { kind: "docker" }>,
  workspacePath: string,
  environment: Record<string, string>,
  openCodeArgs: string[],
): LaunchCommandSpec {
  const configDir = environment.OPENCODE_CONFIG_DIR?.trim()
  if (!configDir) {
    throw new Error("OPENCODE_CONFIG_DIR is required for Docker execution profiles")
  }

  const containerEnvironment: Record<string, string> = { ...environment }
  containerEnvironment.OPENCODE_CONFIG_DIR = execution.configMountPath

  if (containerEnvironment.CODENOMAD_BASE_URL) {
    containerEnvironment.CODENOMAD_BASE_URL = rewriteDockerBaseUrl(containerEnvironment.CODENOMAD_BASE_URL)
  }
  if (containerEnvironment.OPENCODE_SERVER_BASE_URL) {
    containerEnvironment.OPENCODE_SERVER_BASE_URL = rewriteDockerBaseUrl(containerEnvironment.OPENCODE_SERVER_BASE_URL)
  }

  const nodeExtraCaCerts = containerEnvironment.NODE_EXTRA_CA_CERTS?.trim()
  const dockerArgs = [
    "run",
    "--rm",
    "-i",
    "--workdir",
    execution.workspaceMountPath,
    "--add-host",
    `${DOCKER_HOST_ALIAS}:host-gateway`,
    "-v",
    `${workspacePath}:${execution.workspaceMountPath}`,
    "-v",
    `${configDir}:${execution.configMountPath}`,
  ]

  if (nodeExtraCaCerts) {
    dockerArgs.push("-v", `${nodeExtraCaCerts}:${DOCKER_CA_CERT_PATH}:ro`)
    containerEnvironment.NODE_EXTRA_CA_CERTS = DOCKER_CA_CERT_PATH
  }

  for (const [key, value] of Object.entries(containerEnvironment)) {
    dockerArgs.push("-e", key)
  }

  if (execution.extraDockerArgs?.length) {
    dockerArgs.push(...execution.extraDockerArgs)
  }

  dockerArgs.push(execution.image)
  dockerArgs.push(...(execution.command?.length ? execution.command : ["opencode"]))
  dockerArgs.push(...openCodeArgs)

  return {
    command: "docker",
    args: dockerArgs,
    environment: containerEnvironment,
  }
}

function collectPreviewEnvironment(
  explicitEnvironment: Record<string, string>,
  mergedEnvironment: NodeJS.ProcessEnv,
  spawnEnvironment: NodeJS.ProcessEnv | undefined,
): Record<string, string> {
  const previewKeys = new Set(Object.keys(explicitEnvironment))

  if (spawnEnvironment) {
    for (const [key, value] of Object.entries(spawnEnvironment)) {
      if (typeof value !== "string") {
        continue
      }
      if (value !== mergedEnvironment[key]) {
        previewKeys.add(key)
      }
    }
  }

  const previewEnvironment: Record<string, string> = {}
  for (const key of previewKeys) {
    const value = spawnEnvironment?.[key] ?? mergedEnvironment[key]
    if (typeof value === "string") {
      previewEnvironment[key] = value
    }
  }

  return previewEnvironment
}

function formatCommandToken(token: string): string {
  if (!token) {
    return '""'
  }

  return /[\s"'`$&|<>()[\]{};\\]/.test(token) ? JSON.stringify(token) : token
}

function rewriteDockerBaseUrl(input: string): string {
  try {
    const url = new URL(input)
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      url.hostname = DOCKER_HOST_ALIAS
    }
    return url.toString().replace(/\/$/, "")
  } catch {
    return input
  }
}
