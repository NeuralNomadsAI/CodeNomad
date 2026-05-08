import { URL } from "url"
import type { ResolvedBinary } from "../settings/binaries"

const DOCKER_HOST_ALIAS = "host.docker.internal"
const DOCKER_CA_CERT_PATH = "/tmp/codenomad-node-extra-ca.pem"

export interface LaunchCommandSpec {
  command: string
  args: string[]
  cwd?: string
  environment?: Record<string, string>
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
  }
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
    dockerArgs.push("-e", `${key}=${value}`)
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
