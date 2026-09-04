import {
  OpenCodeCliService,
  type OpenCodeCliServiceDependencies,
  type ServiceExecOptions,
} from "./opencode-cli-service"
import { daemonProcessEnvironment } from "./host-opencode-service"

const DEFAULT_TIMEOUT_MS = 30_000

export type WslOpenCodeServiceDependencies = OpenCodeCliServiceDependencies

export interface WslOpenCodeServiceOptions {
  distro: string
  binary: string
  startupEnvironment?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export class WslOpenCodeService extends OpenCodeCliService {
  constructor(
    options: WslOpenCodeServiceOptions,
    dependencies: Partial<WslOpenCodeServiceDependencies> = {},
  ) {
    super({
      label: "WSL",
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      command: (args, start) => ({
        command: "wsl.exe",
        args: [
          "--distribution", options.distro, "--exec",
          ...(start && Object.keys(options.startupEnvironment ?? {}).length
            ? ["env", ...environmentAssignments(options.startupEnvironment!)]
            : []),
          options.binary,
          ...args,
        ],
        options: {},
        ...(start ? { env: daemonProcessEnvironment() } : {}),
      }),
      unreachableMessage: (url) => `Cannot reach the WSL OpenCode service from Windows at ${url}. `
        + "Enable WSL localhost forwarding or configure a Windows opencode2 binary.",
    }, dependencies)
  }
}

function environmentAssignments(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value ?? ""}`)
}

export type { ServiceExecOptions }
