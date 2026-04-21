import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

function safeModuleDir(importMetaUrl: string): string | null {
  try {
    return path.dirname(fileURLToPath(importMetaUrl))
  } catch {
    return null
  }
}

function firstExistingPath(candidates: Array<string | null | undefined>, predicate: (value: string) => boolean): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    if (predicate(candidate)) {
      return candidate
    }
  }
  return null
}

export function getPackagedDistDir(): string {
  return path.dirname(process.execPath)
}

export function resolveServerPackageRoot(importMetaUrl: string): string {
  const moduleDir = safeModuleDir(importMetaUrl)
  const configuredRoot = process.env.CODENOMAD_SERVER_ROOT?.trim()
  const candidates = [
    configuredRoot ? path.resolve(configuredRoot) : null,
    moduleDir ? path.resolve(moduleDir, "..") : null,
    path.resolve(getPackagedDistDir(), ".."),
  ]

  return (
    firstExistingPath(candidates, (value) => fs.existsSync(path.join(value, "package.json"))) ??
    candidates.find((value): value is string => Boolean(value)) ??
    process.cwd()
  )
}

export function resolveServerPublicDir(importMetaUrl: string): string {
  const moduleDir = safeModuleDir(importMetaUrl)
  const candidates = [moduleDir ? path.resolve(moduleDir, "../public") : null, path.join(resolveServerPackageRoot(importMetaUrl), "public")]

  return firstExistingPath(candidates, (value) => fs.existsSync(value)) ?? candidates[candidates.length - 1]!
}

export function resolveAuthTemplatePath(importMetaUrl: string, fileName: string): string {
  const moduleDir = safeModuleDir(importMetaUrl)
  const distDir = getPackagedDistDir()
  const candidates = [
    moduleDir ? path.join(moduleDir, "auth-pages", fileName) : null,
    path.join(distDir, "auth-pages", fileName),
    path.join(distDir, "server", "routes", "auth-pages", fileName),
  ]

  return firstExistingPath(candidates, (value) => fs.existsSync(value)) ?? candidates[0]!
}

export function resolveOpencodeTemplateDir(importMetaUrl: string): string {
  const moduleDir = safeModuleDir(importMetaUrl)
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    moduleDir ? path.resolve(moduleDir, "../../opencode-config") : null,
    resourcesPath ? path.resolve(resourcesPath, "opencode-config") : null,
    moduleDir ? path.resolve(moduleDir, "opencode-config") : null,
    path.join(getPackagedDistDir(), "opencode-config"),
  ]

  return firstExistingPath(candidates, (value) => fs.existsSync(value)) ?? candidates[candidates.length - 1]!
}

export function readServerPackageVersion(importMetaUrl: string): string {
  const packageJsonPath = path.join(resolveServerPackageRoot(importMetaUrl), "package.json")
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { version?: unknown }
  return typeof parsed.version === "string" && parsed.version.trim().length > 0 ? parsed.version : "0.0.0"
}
