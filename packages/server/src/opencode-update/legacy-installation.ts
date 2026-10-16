import { readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { isBelowOpenCodeMinimum } from "../opencode/runtime-support"

/** OpenCode 1.x is published on npm as `opencode-ai`; 2.x as `@opencode/cli`.
 * Both declare an `opencode` bin, so npm refuses to link 2.x over a 1.x shim. */
export const LEGACY_NPM_PACKAGE = "opencode-ai"

export interface LegacyNpmInstallation {
  command: string
  prefix: string
  binary: string
  version: string
}

export function legacyNpmPackageRoot(prefix: string, platform: NodeJS.Platform): string {
  return path.join(prefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules", LEGACY_NPM_PACKAGE)
}

function samePath(left: string, right: string, platform: NodeJS.Platform) {
  const normalize = (value: string) => platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
  return normalize(left) === normalize(right)
}

/** Recognize only the shim npm generated in `commandDirectory` for the legacy
 * package's own `opencode` bin, verified through its manifest and shim target.
 * A version string alone never identifies a replaceable installation. */
export function legacyNpmInstallation(command: string, prefix: string, commandDirectory: string, platform: NodeJS.Platform): LegacyNpmInstallation | undefined {
  if (!samePath(path.dirname(command), commandDirectory, platform)) return undefined
  if (path.basename(command).replace(platform === "win32" ? /\.cmd$/i : /$^/, "") !== "opencode") return undefined
  const root = legacyNpmPackageRoot(prefix, platform)
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string; version?: string; bin?: unknown }
    const relative = manifest.bin && typeof manifest.bin === "object" ? (manifest.bin as Record<string, unknown>).opencode : undefined
    if (manifest.name !== LEGACY_NPM_PACKAGE || typeof relative !== "string" || typeof manifest.version !== "string"
      || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !isBelowOpenCodeMinimum(manifest.version)) return undefined
    const binary = path.resolve(root, relative)
    if (!binary.startsWith(root + path.sep) || !statSync(binary).isFile()) return undefined
    if (platform === "win32") {
      const script = readFileSync(command, "utf8")
      if (script.length > 64 * 1024) return undefined
      const target = script.match(/(?:%~dp0|%dp0%)[\\/]([^"'\r\n]+?)["']\s+%\*/i)?.[1]
      if (!target || !samePath(path.win32.resolve(path.dirname(command), target), binary, platform)) return undefined
    } else if (realpathSync(command) !== realpathSync(binary)) return undefined
    return { command, prefix, binary, version: manifest.version }
  } catch { return undefined }
}

function environmentValue(env: NodeJS.ProcessEnv, name: string) {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}

const WINGET_COMMUNITY_SOURCE = "Microsoft.Winget.Source_8wekyb3d8bbwe"

/** winget portable packages expose commands through a Links directory (a
 * symlink, or a hardlink/copy fallback) or, when links are unavailable, by
 * adding `<root>\Packages\<PackageIdentifier>_<SourceIdentifier>` to PATH.
 * Only default winget locations are recognized; the package ID is reported only
 * when the resolved directory name proves it. */
export function wingetInstallation(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { packageId?: string } | undefined {
  if (platform !== "win32") return undefined
  const local = environmentValue(env, "LOCALAPPDATA")
  const programFiles = environmentValue(env, "ProgramFiles")
  const programFilesX86 = environmentValue(env, "ProgramFiles(x86)")
  const links = [local && path.join(local, "Microsoft", "WinGet", "Links"), programFiles && path.join(programFiles, "WinGet", "Links")]
  const roots = [local && path.join(local, "Microsoft", "WinGet", "Packages"), programFiles && path.join(programFiles, "WinGet", "Packages"),
    programFilesX86 && path.join(programFilesX86, "WinGet", "Packages")]
  let target = command
  try { target = realpathSync(command) } catch { /* Classify the PATH entry itself. */ }
  const linked = links.some(directory => directory && samePath(path.dirname(command), directory, platform))
  const root = roots.find(directory => directory && path.resolve(target).toLowerCase().startsWith(path.resolve(directory).toLowerCase() + path.sep))
  if (!linked && !root) return undefined
  const directory = root ? path.relative(root, target).split(path.sep)[0] : undefined
  const suffix = `_${WINGET_COMMUNITY_SOURCE}`
  const packageId = directory?.endsWith(suffix) ? directory.slice(0, -suffix.length) : undefined
  return packageId && /^[A-Za-z0-9][A-Za-z0-9.\-]*$/.test(packageId) ? { packageId } : {}
}
