import type { SettingsService } from "./service"
import type {
  CommandExecutionProfile,
  DockerExecutionProfile,
  ExecutionProfile,
  ExecutionProfileKind,
  LocalExecutionProfile,
  WslExecutionProfile,
} from "../api-types"

export interface OpenCodeBinaryEntry {
  path: string
  version?: string
  lastUsed?: number
  label?: string
}

interface ResolvedExecutionBase {
  label: string
  version?: string
  executionProfileId?: string
  executionProfileName?: string
  executionProfileKind?: ExecutionProfileKind
}

export interface ResolvedHostExecution extends ResolvedExecutionBase {
  kind: "local" | "wsl"
  path: string
}

export interface ResolvedDockerExecution extends ResolvedExecutionBase {
  kind: "docker"
  image: string
  workspaceMountPath: string
  configMountPath: string
  command?: string[]
  extraDockerArgs?: string[]
}

export interface ResolvedCommandExecution extends ResolvedExecutionBase {
  kind: "command"
  executable: string
  args?: string[]
  cwdMode?: "workspace" | "inherit"
}

export type ResolvedBinary = ResolvedHostExecution | ResolvedDockerExecution | ResolvedCommandExecution

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
      path,
      label: entry?.label ?? prettyLabel(path),
      version: entry?.version,
    }
  }

  private resolveProfile(profile: ExecutionProfile): ResolvedBinary {
    const shared = {
      label: profile.name,
      executionProfileId: profile.id,
      executionProfileName: profile.name,
      executionProfileKind: profile.kind,
    }

    if (profile.kind === "local") {
      return this.resolveLocalProfile(profile, shared)
    }

    if (profile.kind === "wsl") {
      return this.resolveWslProfile(profile, shared)
    }

    if (profile.kind === "docker") {
      return this.resolveDockerProfile(profile, shared)
    }

    return this.resolveCommandProfile(profile, shared)
  }

  private resolveLocalProfile(profile: LocalExecutionProfile, shared: Omit<ResolvedHostExecution, "kind" | "path">): ResolvedHostExecution {
    return {
      ...shared,
      kind: "local",
      path: profile.binaryPath,
    }
  }

  private resolveWslProfile(profile: WslExecutionProfile, shared: Omit<ResolvedHostExecution, "kind" | "path">): ResolvedHostExecution {
    return {
      ...shared,
      kind: "wsl",
      path: profile.binaryPath,
    }
  }

  private resolveDockerProfile(profile: DockerExecutionProfile, shared: Omit<ResolvedDockerExecution, "kind" | "image" | "workspaceMountPath" | "configMountPath">): ResolvedDockerExecution {
    return {
      ...shared,
      kind: "docker",
      image: profile.image,
      workspaceMountPath: profile.workspaceMountPath,
      configMountPath: profile.configMountPath,
      command: profile.command,
      extraDockerArgs: profile.extraDockerArgs,
    }
  }

  private resolveCommandProfile(profile: CommandExecutionProfile, shared: Omit<ResolvedCommandExecution, "kind" | "executable">): ResolvedCommandExecution {
    return {
      ...shared,
      kind: "command",
      executable: profile.executable,
      args: profile.args,
      cwdMode: profile.cwdMode,
    }
  }
}
