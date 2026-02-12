import os from "os"
import path from "path"

export interface ConfigLocation {
  /** Resolved absolute base directory containing all persisted server data. */
  baseDir: string
  /** Canonical YAML config file path (may be custom when input points to a YAML file). */
  configYamlPath: string
  /** Canonical YAML state file path (always in baseDir). */
  stateYamlPath: string
  /** Legacy JSON config file path used for migration (always in baseDir, or explicit JSON input). */
  legacyJsonPath: string
  /** Directory for per-instance persisted data (chat history etc.). */
  instancesDir: string
}

function resolvePath(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2))
  }
  return path.resolve(inputPath)
}

function isYamlPath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith(".yaml") || lower.endsWith(".yml")
}

function isJsonPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".json")
}

/**
 * Resolve CodeNomad's config location into a stable base directory + derived file paths.
 *
 * Supported inputs:
 * - Directory: "~/.config/codenomad"
 * - YAML file: "~/.config/codenomad/config.yaml" (or any *.yml/*.yaml)
 * - Legacy JSON file: "~/.config/codenomad/config.json"
 */
export function resolveConfigLocation(raw: string): ConfigLocation {
  const trimmed = (raw ?? "").trim()
  const fallback = "~/.config/codenomad/config.json"
  const input = trimmed.length > 0 ? trimmed : fallback

  const resolvedInput = resolvePath(input)

  if (isYamlPath(resolvedInput)) {
    const baseDir = path.dirname(resolvedInput)
    return {
      baseDir,
      configYamlPath: resolvedInput,
      stateYamlPath: path.join(baseDir, "state.yaml"),
      legacyJsonPath: path.join(baseDir, "config.json"),
      instancesDir: path.join(baseDir, "instances"),
    }
  }

  if (isJsonPath(resolvedInput)) {
    const baseDir = path.dirname(resolvedInput)
    return {
      baseDir,
      configYamlPath: path.join(baseDir, "config.yaml"),
      stateYamlPath: path.join(baseDir, "state.yaml"),
      legacyJsonPath: resolvedInput,
      instancesDir: path.join(baseDir, "instances"),
    }
  }

  const baseDir = resolvedInput
  return {
    baseDir,
    configYamlPath: path.join(baseDir, "config.yaml"),
    stateYamlPath: path.join(baseDir, "state.yaml"),
    legacyJsonPath: path.join(baseDir, "config.json"),
    instancesDir: path.join(baseDir, "instances"),
  }
}
