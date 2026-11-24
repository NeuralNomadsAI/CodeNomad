import { readFileSync } from "node:fs"
import os from "node:os"

export interface OperatingSystemFacts {
  platform: NodeJS.Platform
  release: string
  /** Node's `os.version()`: the product name on Windows (e.g. "Windows 11 Pro"). */
  version?: string
  readOsRelease?: () => string
}

/** Readable OS release for diagnostics, e.g. "Windows 11 Pro (10.0.26200)",
 * "macOS 26.1" or a Linux distribution's PRETTY_NAME. */
export function describeOperatingSystem({
  platform,
  release,
  version = "",
  readOsRelease = () => readFileSync("/etc/os-release", "utf8"),
}: OperatingSystemFacts): string | undefined {
  if (platform === "win32") {
    // The product name distinguishes Windows Server and editions; Windows 11 kept
    // the 10.0 kernel version, so only the build number tells it apart otherwise.
    if (version.trim()) return `${version.trim()} (${release})`
    const [major, , build] = release.split(".").map(Number)
    if (major === 10) return `Windows ${build >= 22000 ? 11 : 10} (${release})`
    return `Windows (${release})`
  }
  if (platform === "darwin") {
    const [darwin, minor] = release.split(".").map(Number)
    // macOS jumped from 15 to 26 (Tahoe, Darwin 25). From Darwin 23 the minor
    // tracks macOS's own; for Darwin 20-22 it runs one ahead, so it is omitted.
    if (darwin >= 25) return `macOS ${darwin + 1}${minor ? `.${minor}` : ""}`
    if (darwin >= 23) return `macOS ${darwin - 9}${minor ? `.${minor}` : ""}`
    if (darwin >= 20) return `macOS ${darwin - 9}`
    return `macOS (Darwin ${release})`
  }
  if (platform === "linux") {
    try {
      const pretty = readOsRelease().match(/^PRETTY_NAME=(["']?)(.+)\1$/m)?.[2]?.trim()
      if (pretty) return pretty
    } catch {
      // Minimal containers may not ship /etc/os-release.
    }
    return `Linux ${release}`
  }
  return undefined
}

let cached: string | undefined | null = null

export function serverOperatingSystemName(): string | undefined {
  if (cached === null) {
    let version = ""
    try { version = os.version() } catch { /* unavailable on some platforms */ }
    cached = describeOperatingSystem({ platform: process.platform, release: os.release(), version })
  }
  return cached
}
