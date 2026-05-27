import type { SettingsService } from "./service"
import type {
  CommandExecutionProfile,
  DockerExecutionProfile,
  ExecutionProfile,
  ExecutionProfileKind,
  LocalExecutionProfile,
  SshExecutionProfile,
  WslExecutionProfile,
} from "../api-types"

export interface OpenCodeBinaryEntry {
  path: string
  version?: string
  lastUsed?: number
  label?: string
}

export interface HostLauncherContract {
  transport: "host"
  command: string
  args?: string[]
  cwdMode?: "workspace" | "inherit"
  wslDistro?: string
}

export interface DockerLauncherContract {
  transport: "docker"
  image: string
  workspaceMountPath: string
  configMountPath: string
  command: string
  args?: string[]
  extraDockerArgs?: string[]
}

export interface SshLauncherContract {
  transport: "ssh"
  host: string
  port?: number
  username?: string
  remotePath: string
  command: string
  args?: string[]
}

export type ExecutionLauncherContract = HostLauncherContract | DockerLauncherContract | SshLauncherContract

interface ResolvedExecutionBase {
  label: string
  version?: string
  executionProfileId?: string
  executionProfileName?: string
  executionProfileKind?: ExecutionProfileKind
}

export interface ResolvedBinary extends ResolvedExecutionBase {
  kind: ExecutionProfileKind
  launcher: ExecutionLauncherContract
}

export interface ResolvedSshExecution extends ResolvedBinary {
  kind: "ssh"
  launcher: SshLauncherContract
}

function prettyLabel(p: string): string {
  const parts = p.split(/[\\/]/)
  const last = parts[parts.length - 1] || p
  return last || p
}

function readUiBinaries(settings: SettingsService): OpenCodeBinaryEntry[] {
  const ui = settings.getOwner("state", "ui")
  const list = (ui as any)?.opencodeBinaries
  if (!Array.isArray(list)) return []
  return list.filter((item) => item && typeof item === "object" && typeof (item as any).path === "string") as any
}

function readDefaultBinaryPath(settings: SettingsService): string | undefined {
  const server = settings.getOwner("config", "server")
  const value = (server as any)?.opencodeBinary
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function isExecutionProfile(value: unknown): value is ExecutionProfile {
  return !!value && typeof value === "object" && typeof (value as any).id === "string" && typeof (value as any).kind === "string"
}

function readExecutionProfiles(settings: SettingsService): ExecutionProfile[] {
  const server = settings.getOwner("config", "server")
  const list = (server as any)?.executionProfiles
  if (!Array.isArray(list)) return []
  return list.filter(isExecutionProfile)
}

function readDefaultExecutionProfileId(settings: SettingsService): string | undefined {
  const server = settings.getOwner("config", "server")
  const value = (server as any)?.defaultExecutionProfileId
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function buildResolvedProfile(profile: ExecutionProfile): ResolvedBinary {
  const shared = {
    label: profile.name,
    executionProfileId: profile.id,
    executionProfileName: profile.name,
    executionProfileKind: profile.kind,
  }

  if (profile.kind === "local") {
    return {
      ...shared,
      kind: "local",
      launcher: {
        transport: "host",
        command: profile.binaryPath,
        cwdMode: "workspace",
      },
    }
  }

  if (profile.kind === "wsl") {
    return {
      ...shared,
      kind: "wsl",
      launcher: {
        transport: "host",
        command: profile.binaryPath,
        cwdMode: "workspace",
        wslDistro: profile.distro,
      },
    }
  }

  if (profile.kind === "docker") {
    const [command = "opencode", ...args] = profile.command?.length ? profile.command : ["opencode"]
    return {
      ...shared,
      kind: "docker",
      launcher: {
        transport: "docker",
        image: profile.image,
        workspaceMountPath: profile.workspaceMountPath,
        configMountPath: profile.configMountPath,
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(profile.extraDockerArgs?.length ? { extraDockerArgs: profile.extraDockerArgs } : {}),
      },
    }
  }

  if (profile.kind === "command") {
    return {
      ...shared,
      kind: "command",
      launcher: {
        transport: "host",
        command: profile.executable,
        args: profile.args,
        cwdMode: profile.cwdMode,
      },
    }
  }

  return {
    ...shared,
    kind: "ssh",
    launcher: {
      transport: "ssh",
      host: profile.host,
      port: profile.port,
      username: profile.username,
      remotePath: profile.remotePath,
      command: profile.binaryPath,
      args: profile.args,
    },
  }
}

export class BinaryResolver {
  constructor(private readonly settings: SettingsService) {}

  list(): OpenCodeBinaryEntry[] {
    return readUiBinaries(this.settings)
  }

  listExecutionProfiles(): ExecutionProfile[] {
    return readExecutionProfiles(this.settings)
  }

  resolveActive(executionProfileId?: string): ResolvedBinary {
    const profiles = this.listExecutionProfiles()
    const requestedId = executionProfileId?.trim() || readDefaultExecutionProfileId(this.settings)
    if (!requestedId) {
      return this.resolveDefault()
    }

    const profile = profiles.find((entry) => entry.id === requestedId)
    if (!profile) {
      if (executionProfileId?.trim()) {
        throw new Error(`Execution profile not found: ${executionProfileId}`)
      }
      return this.resolveDefault()
    }

    return this.resolveProfile(profile)
  }

  resolveDefault(): ResolvedBinary {
    const binaries = this.list()
    const configuredDefault = readDefaultBinaryPath(this.settings)
    const fallback = binaries[0]?.path
    const path = configuredDefault ?? fallback ?? "opencode"

    const entry = binaries.find((b) => b.path === path)
    return {
      kind: "local",
      label: entry?.label ?? prettyLabel(path),
      version: entry?.version,
      launcher: {
        transport: "host",
        command: path,
        cwdMode: "workspace",
      },
    }
  }

  private resolveProfile(profile: ExecutionProfile): ResolvedBinary {
    return buildResolvedProfile(profile)
  }
}

export function resolveExecutionProfile(profile: ExecutionProfile): ResolvedBinary {
  return buildResolvedProfile(profile)
}

export function getLaunchBinaryIdentifier(resolved: ResolvedBinary): string {
  switch (resolved.launcher.transport) {
    case "host":
      return resolved.launcher.command
    case "docker":
      return "docker"
    case "ssh":
      return "ssh"
  }
}
