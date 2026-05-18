import { URL } from "url"
import type { ResolvedBinary } from "../settings/binaries"
import {
  findPackagedCodeNomadPluginReference,
  rewritePackagedCodeNomadPluginReference,
} from "../opencode-plugin.js"
import { buildSpawnSpec, WSL_PID_MARKER } from "./spawn"

const DOCKER_HOST_ALIAS = "host.docker.internal"
const DOCKER_CA_CERT_PATH = "/tmp/codenomad-node-extra-ca.pem"
const DOCKER_PLUGIN_TARBALL_NAME = "codenomad-opencode-plugin.tgz"

export interface LaunchCommandSpec {
  command: string
  args: string[]
  cwd?: string
  environment?: Record<string, string>
  wslDistro?: string
  stdin?: string
}

interface BuildLaunchCommandParams {
  execution: ResolvedBinary
  workspacePath: string
  environment: Record<string, string>
  logLevel: string
  reservedPort?: number
  callbackPort?: number
}

export function buildLaunchCommand(params: BuildLaunchCommandParams): LaunchCommandSpec {
  const openCodePort = (params.execution.kind === "docker" || params.execution.kind === "ssh") && params.reservedPort ? String(params.reservedPort) : "0"
  const openCodeArgs = ["serve", "--port", openCodePort, "--print-logs", "--log-level", params.logLevel]
  if (params.execution.kind === "docker") {
    openCodeArgs.push("--hostname", "0.0.0.0")
  }

  if (params.execution.kind === "docker") {
    if (!params.reservedPort) {
      throw new Error("Reserved local port is required for Docker execution profiles")
    }
    return buildDockerLaunchCommand(params.execution, params.workspacePath, params.environment, openCodeArgs, params.reservedPort)
  }

  if (params.execution.kind === "command") {
    return {
      command: params.execution.executable,
      args: [...(params.execution.args ?? []), ...openCodeArgs],
      cwd: params.execution.cwdMode === "inherit" ? undefined : params.workspacePath,
      environment: params.environment,
    }
  }

  if (params.execution.kind === "ssh") {
    if (!params.reservedPort || !params.callbackPort) {
      throw new Error("Reserved local and callback ports are required for SSH execution profiles")
    }
    return buildSshLaunchCommand(params.execution, params.reservedPort, params.callbackPort, params.environment, openCodeArgs)
  }

  return {
    command: params.execution.path,
    args: openCodeArgs,
    cwd: params.workspacePath,
    environment: params.environment,
    wslDistro: params.execution.kind === "wsl" ? params.execution.wslDistro : undefined,
  }
}

function buildSshLaunchCommand(
  execution: Extract<ResolvedBinary, { kind: "ssh" }>,
  forwardedPort: number,
  callbackPort: number,
  environment: Record<string, string>,
  openCodeArgs: string[],
): LaunchCommandSpec {
  const host = execution.host.trim()
  if (!host || host.startsWith("-") || /\s/.test(host)) {
    throw new Error("SSH host must not be empty, start with '-', or contain whitespace")
  }

  const username = execution.username?.trim()
  if (username && (username.startsWith("-") || /[@\s]/.test(username))) {
    throw new Error("SSH username must not start with '-' or contain '@' or whitespace")
  }

  const target = username ? `${username}@${host}` : host
  const remoteEnvironment = rewriteSshCallbackEnvironment(environment, callbackPort)
  const remoteScript = buildSshRemoteScript(execution, remoteEnvironment, openCodeArgs)

  return {
    command: "ssh",
    args: [
      "-p",
      String(execution.port ?? 22),
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `127.0.0.1:${forwardedPort}:127.0.0.1:${forwardedPort}`,
      "-R",
      `127.0.0.1:${callbackPort}:127.0.0.1:${getUrlPort(environment.CODENOMAD_BASE_URL) ?? 9898}`,
      target,
      "sh",
      "-s",
    ],
    environment: {},
    stdin: remoteScript,
  }
}

function buildSshRemoteScript(
  execution: Extract<ResolvedBinary, { kind: "ssh" }>,
  environment: Record<string, string>,
  openCodeArgs: string[],
): string {
  const assignments = Object.entries(environment).map(([key, value]) => {
    if (!isEnvironmentVariableName(key)) {
      throw new Error(`Invalid environment variable name for SSH execution profile: ${key}`)
    }
    return `${key}=${shellQuote(value)}`
  })

  const command = [
    "exec",
    "env",
    ...assignments,
    shellQuote(execution.binaryPath),
    ...(execution.args ?? []).map(shellQuote),
    ...openCodeArgs.map(shellQuote),
  ].join(" ")

  return ["set -eu", `cd ${shellQuote(execution.remotePath)}`, command, ""].join("\n")
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
  forwardedPort: number,
): LaunchCommandSpec {
  const configContent = environment.OPENCODE_CONFIG_CONTENT?.trim()
  if (!configContent) {
    throw new Error("OPENCODE_CONFIG_CONTENT is required for Docker execution profiles")
  }

  const containerEnvironment: Record<string, string> = { ...environment }
  const packagedPlugin = findPackagedCodeNomadPluginReference(configContent)

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
    "-p",
    `127.0.0.1:${forwardedPort}:${forwardedPort}`,
    "-v",
    `${workspacePath}:${execution.workspaceMountPath}`,
  ]

  if (packagedPlugin) {
    const containerPluginPath = joinPosixPath(execution.configMountPath, DOCKER_PLUGIN_TARBALL_NAME)
    containerEnvironment.OPENCODE_CONFIG_CONTENT = rewritePackagedCodeNomadPluginReference(configContent, containerPluginPath)
    dockerArgs.push("-v", `${packagedPlugin.filePath.replace(/\\/g, "/")}:${containerPluginPath}:ro`)
  }

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

function shellQuote(value: string): string {
  if (!value) return "''"
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function isEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

function rewriteSshCallbackEnvironment(environment: Record<string, string>, callbackPort: number): Record<string, string> {
  const rewritten = { ...environment }
  for (const key of ["CODENOMAD_BASE_URL", "OPENCODE_SERVER_BASE_URL"]) {
    const value = rewritten[key]
    if (!value) continue
    rewritten[key] = rewriteUrlHostPort(value, "127.0.0.1", callbackPort)
  }
  return rewritten
}

function rewriteUrlHostPort(value: string, host: string, port: number): string {
  try {
    const url = new URL(value)
    url.hostname = host
    url.port = String(port)
    return url.toString().replace(/\/$/, "")
  } catch {
    return value
  }
}

function getUrlPort(value?: string): number | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    const parsed = Number(url.port || (url.protocol === "https:" ? 443 : 80))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  } catch {
    return undefined
  }
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

function joinPosixPath(base: string, name: string): string {
  return `${base.replace(/\/+$/, "")}/${name}`
}
