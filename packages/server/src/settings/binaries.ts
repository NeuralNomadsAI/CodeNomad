import type { SettingsService } from "./service"
import { resolveDefaultInstallation } from "../opencode-update/shared-installation"
import { isRetiredInstallation } from "../opencode-update/retired-installation"

export interface OpenCodeBinaryEntry {
  path: string
  version?: string
  lastUsed?: number
  label?: string
}

export interface ResolvedBinary {
  path: string
  label: string
  version?: string
  source?: "path" | "user"
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

export class BinaryResolver {
  constructor(private readonly settings: SettingsService, private readonly resolveInstallation = resolveDefaultInstallation) {}

  list(): OpenCodeBinaryEntry[] {
    return readUiBinaries(this.settings).filter(binary => !isRetiredInstallation(binary.path))
  }

  resolveDefault(): ResolvedBinary {
    const binaries = this.list()
    const configuredDefault = readDefaultBinaryPath(this.settings)
    const selected = !configuredDefault || configuredDefault === "opencode" || isRetiredInstallation(configuredDefault) ? "opencode2" : configuredDefault
    const installation = selected === "opencode2" ? this.resolveInstallation() : undefined
    const path = installation?.path ?? selected

    const entry = binaries.find((b) => b.path === path)
    return {
      path,
      label: entry?.label ?? prettyLabel(path),
      version: entry?.version,
      ...(installation ? { source: installation.source } : {}),
    }
  }
}
