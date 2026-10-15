import { readFileSync } from "node:fs"
import os from "node:os"

/** Readable OS release for diagnostics, e.g. "Windows 11 (10.0.26200)",
 * "macOS 15.1" or a Linux distribution's PRETTY_NAME. */
export function describeOperatingSystem(
  platform: NodeJS.Platform = process.platform,
  release: string = os.release(),
  readOsRelease: () => string = () => readFileSync("/etc/os-release", "utf8"),
): string | undefined {
  if (platform === "win32") {
    const [major, , build] = release.split(".").map(Number)
    // Windows 11 kept the 10.0 kernel version; its builds start at 22000.
    if (major === 10) return `Windows ${build >= 22000 ? 11 : 10} (${release})`
    return `Windows (${release})`
  }
  if (platform === "darwin") {
    const [darwin, minor] = release.split(".").map(Number)
    // Darwin 20 is macOS 11; the minor version tracks macOS's own.
    if (darwin >= 20) return `macOS ${darwin - 9}${minor ? `.${minor}` : ""}`
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
  if (cached === null) cached = describeOperatingSystem()
  return cached
}
