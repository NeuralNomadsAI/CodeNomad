import { existsSync, readFileSync } from "fs"
import os from "os"
import path from "path"
import { parse as parseYaml } from "yaml"

export type ListeningMode = "local" | "all"

interface PreferencesConfig {
  listeningMode?: string
  httpPort?: number
  httpsPort?: number
}

interface ServerConfig {
  listeningMode?: string
  httpPort?: number
  httpsPort?: number
}

interface AppConfig {
  preferences?: PreferencesConfig
  server?: ServerConfig
}

const DEFAULT_CONFIG_PATH = "~/.config/codenomad/config.json"

function isYamlPath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith(".yaml") || lower.endsWith(".yml")
}

function isJsonPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".json")
}

export function resolveConfigPaths(raw?: string): { configYamlPath: string; legacyJsonPath: string } {
  const target = raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_CONFIG_PATH
  const resolved = resolveConfigPath(target)

  if (isYamlPath(resolved)) {
    const baseDir = path.dirname(resolved)
    return { configYamlPath: resolved, legacyJsonPath: path.join(baseDir, "config.json") }
  }

  if (isJsonPath(resolved)) {
    const baseDir = path.dirname(resolved)
    return { configYamlPath: path.join(baseDir, "config.yaml"), legacyJsonPath: resolved }
  }

  return {
    configYamlPath: path.join(resolved, "config.yaml"),
    legacyJsonPath: path.join(resolved, "config.json"),
  }
}

function resolveConfigPath(configPath?: string): string {
  const target = configPath && configPath.trim().length > 0 ? configPath : DEFAULT_CONFIG_PATH
  if (target.startsWith("~/")) {
    return path.join(os.homedir(), target.slice(2))
  }
  return path.resolve(target)
}

function readAppConfig(configPath?: string): AppConfig | null {
  const { configYamlPath, legacyJsonPath } = resolveConfigPaths(configPath)
  return readAppConfigFromPaths(configYamlPath, legacyJsonPath)
}

export function readAppConfigFromPaths(configYamlPath: string, legacyJsonPath: string): AppConfig | null {
  if (existsSync(configYamlPath)) {
    const content = readFileSync(configYamlPath, "utf-8")
    return parseYaml(content) as AppConfig
  }

  if (existsSync(legacyJsonPath)) {
    const content = readFileSync(legacyJsonPath, "utf-8")
    return JSON.parse(content) as AppConfig
  }

  return null
}

export function readListeningModeFromConfig(configPath = process.env.CLI_CONFIG): ListeningMode {
  try {
    const parsed = readAppConfig(configPath)
    const mode = parsed?.server?.listeningMode ?? parsed?.preferences?.listeningMode
    if (mode === "local" || mode === "all") {
      return mode
    }
  } catch (error) {
    console.warn("[cli] failed to read listening mode from config", error)
  }
  return "local"
}

export function resolveConfiguredPorts(configPath = process.env.CLI_CONFIG): [httpsPort?: number, httpPort?: number] {
  try {
    const parsed = readAppConfig(configPath)
    return resolveConfiguredPortsFromConfig(parsed)
  } catch (error) {
    console.warn("[cli] failed to read configured ports from config", error)
    return []
  }
}

export function resolveConfiguredPortsFromConfig(config: AppConfig | null | undefined): [httpsPort?: number, httpPort?: number] {
  const httpsPort = config?.server?.httpsPort ?? config?.preferences?.httpsPort
  const httpPort = config?.server?.httpPort ?? config?.preferences?.httpPort
  return [httpsPort, httpPort]
}

export function applyConfiguredPorts(
  args: string[],
  options: {
    httpsPortEnv?: string | null
    httpPortEnv?: string | null
    configuredHttpsPort?: number
    configuredHttpPort?: number
  },
): void {
  const httpsEnvPresent = Boolean(options.httpsPortEnv?.trim())
  const httpEnvPresent = Boolean(options.httpPortEnv?.trim())

  if (!httpsEnvPresent && options.configuredHttpsPort !== undefined) {
    args.push("--https-port", String(options.configuredHttpsPort))
  }

  if (!httpEnvPresent && options.configuredHttpPort !== undefined) {
    args.push("--http-port", String(options.configuredHttpPort))
  }
}
