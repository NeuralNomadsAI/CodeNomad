import fs from "fs"
import path from "path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import type { Logger } from "../logger"
import type { ConfigLocation } from "../config/location"
import { isPlainObject } from "./merge-patch"

type Doc = Record<string, unknown>

function ensureTrailingNewline(content: string): string {
  if (!content) return "\n"
  return content.endsWith("\n") ? content : `${content}\n`
}

function safeReadYaml(filePath: string, logger: Logger): unknown {
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    return parseYaml(content)
  } catch (error) {
    logger.warn({ err: error, filePath }, "Failed to read YAML file during migration")
    return null
  }
}

function safeReadJson(filePath: string, logger: Logger): unknown {
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    return JSON.parse(content)
  } catch (error) {
    logger.warn({ err: error, filePath }, "Failed to read JSON file during migration")
    return null
  }
}

function writeYaml(filePath: string, doc: Doc, logger: Logger) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const yaml = stringifyYaml(doc as any)
    fs.writeFileSync(filePath, ensureTrailingNewline(yaml), "utf-8")
  } catch (error) {
    logger.warn({ err: error, filePath }, "Failed to write YAML file during migration")
  }
}

function pickBackupPath(filePath: string): string {
  const preferred = `${filePath}.bak`
  if (!fs.existsSync(preferred)) {
    return preferred
  }
  return `${filePath}.bak.${Date.now()}`
}

function normalizeDoc(value: unknown): Doc {
  return isPlainObject(value) ? (value as Doc) : {}
}

function looksLikeNewOwnerDoc(value: unknown): boolean {
  const doc = normalizeDoc(value)
  // Heuristic: owner-bucket docs have at least one of these roots.
  return Boolean(doc.ui || doc.server || doc.app || doc.legacy)
}

function looksLikeLegacyConfig(value: unknown): boolean {
  const doc = normalizeDoc(value)
  return Boolean(doc.preferences || doc.opencodeBinaries || doc.theme || doc.recentFolders)
}

function looksLikeLegacyState(value: unknown): boolean {
  const doc = normalizeDoc(value)
  return Boolean(doc.recentFolders)
}

function omitKeys(source: Doc, keys: Set<string>): Doc {
  const out: Doc = {}
  for (const [k, v] of Object.entries(source)) {
    if (keys.has(k)) continue
    out[k] = v
  }
  return out
}

function mapLegacyToOwnerDocs(legacyConfig: unknown, legacyState: unknown): { config: Doc; state: Doc } {
  const cfg = normalizeDoc(legacyConfig)
  const st = normalizeDoc(legacyState)

  const outConfig: Doc = {}
  const outState: Doc = {}

  const uiConfig: Doc = {}
  const uiSettings: Doc = {}
  const serverConfig: Doc = {}
  const uiState: Doc = {}

  // theme -> config.ui.theme
  if (typeof cfg.theme === "string") {
    uiConfig.theme = cfg.theme
  }

  const preferences = normalizeDoc(cfg.preferences)
  if (Object.keys(preferences).length > 0) {
    // Server-owned stable keys
    const envVars = preferences.environmentVariables
    if (isPlainObject(envVars)) {
      serverConfig.environmentVariables = envVars
    }
    const listeningMode = preferences.listeningMode
    if (typeof listeningMode === "string") {
      serverConfig.listeningMode = listeningMode
    }
    const lastUsedBinary = preferences.lastUsedBinary
    if (typeof lastUsedBinary === "string") {
      serverConfig.opencodeBinary = lastUsedBinary
    }

    // UI-owned state keys (drop preferences)
    const modelRecents = preferences.modelRecents
    const modelFavorites = preferences.modelFavorites
    const modelThinkingSelections = preferences.modelThinkingSelections

    const models: Doc = {}
    if (Array.isArray(modelRecents)) {
      models.recents = modelRecents
    }
    if (Array.isArray(modelFavorites)) {
      models.favorites = modelFavorites
    }
    if (isPlainObject(modelThinkingSelections)) {
      models.thinkingSelections = modelThinkingSelections
    }
    if (Object.keys(models).length > 0) {
      uiState.models = models
    }

    // Remaining preferences are treated as stable UI settings.
    const moved = new Set([
      "environmentVariables",
      "listeningMode",
      "lastUsedBinary",
      "modelRecents",
      "modelFavorites",
      "modelThinkingSelections",
    ])
    Object.assign(uiSettings, omitKeys(preferences, moved))
  }

  // recentFolders lives in legacy state (yaml) or legacy config.json
  const recentFolders = (st.recentFolders ?? cfg.recentFolders) as unknown
  if (Array.isArray(recentFolders)) {
    uiState.recentFolders = recentFolders
  }

  // opencodeBinaries -> state.ui.opencodeBinaries
  if (Array.isArray(cfg.opencodeBinaries)) {
    uiState.opencodeBinaries = cfg.opencodeBinaries
  }

  if (Object.keys(uiSettings).length > 0) {
    uiConfig.settings = uiSettings
  }

  if (Object.keys(uiConfig).length > 0) {
    outConfig.ui = uiConfig
  }
  if (Object.keys(serverConfig).length > 0) {
    outConfig.server = serverConfig
  }
  if (Object.keys(uiState).length > 0) {
    outState.ui = uiState
  }

  // Unknown top-level keys -> legacy.unknown
  const knownConfigKeys = new Set(["preferences", "opencodeBinaries", "theme", "recentFolders"])
  const unknownConfig = omitKeys(cfg, knownConfigKeys)
  if (Object.keys(unknownConfig).length > 0) {
    outConfig.legacy = { unknown: unknownConfig }
  }

  const knownStateKeys = new Set(["recentFolders"])
  const unknownState = omitKeys(st, knownStateKeys)
  if (Object.keys(unknownState).length > 0) {
    outState.legacy = { unknown: unknownState }
  }

  return { config: outConfig, state: outState }
}

/**
 * Migrate older config/state layouts into owner-bucket YAML docs.
 *
 * Legacy inputs supported:
 * - config.yaml with { preferences, opencodeBinaries, theme }
 * - state.yaml with { recentFolders }
 * - legacy config.json with full ConfigFile schema
 */
export function migrateSettingsLayout(location: ConfigLocation, logger: Logger) {
  const configYamlPath = location.configYamlPath
  const stateYamlPath = location.stateYamlPath
  const legacyJsonPath = location.legacyJsonPath

  const configExists = fs.existsSync(configYamlPath)
  const stateExists = fs.existsSync(stateYamlPath)

  const configDoc = configExists ? safeReadYaml(configYamlPath, logger) : null
  const stateDoc = stateExists ? safeReadYaml(stateYamlPath, logger) : null

  const configIsNew = configExists && looksLikeNewOwnerDoc(configDoc) && !looksLikeLegacyConfig(configDoc)
  const stateIsNew = stateExists && looksLikeNewOwnerDoc(stateDoc) && !looksLikeLegacyState(stateDoc)

  if (configIsNew && stateIsNew) {
    return
  }

  const legacyJsonExists = fs.existsSync(legacyJsonPath)

  const hasLegacyYaml = (configExists && looksLikeLegacyConfig(configDoc)) || (stateExists && looksLikeLegacyState(stateDoc))
  const shouldMigrateFromJson = !configExists && legacyJsonExists

  if (!hasLegacyYaml && !shouldMigrateFromJson) {
    // Either fresh install or partially written docs; let stores create on first write.
    return
  }

  const sourceConfig = shouldMigrateFromJson ? safeReadJson(legacyJsonPath, logger) : configDoc
  const sourceState = shouldMigrateFromJson ? sourceConfig : stateDoc

  const { config, state } = mapLegacyToOwnerDocs(sourceConfig, sourceState)

  try {
    fs.mkdirSync(location.baseDir, { recursive: true })
  } catch (error) {
    logger.warn({ err: error, baseDir: location.baseDir }, "Failed to create base directory during migration")
  }

  // Backup legacy files before rewriting.
  if (configExists) {
    try {
      const bak = pickBackupPath(configYamlPath)
      fs.renameSync(configYamlPath, bak)
      logger.info({ configYamlPath, bak }, "Backed up legacy config.yaml")
    } catch (error) {
      logger.warn({ err: error, configYamlPath }, "Failed to backup legacy config.yaml")
    }
  }

  if (stateExists) {
    try {
      const bak = pickBackupPath(stateYamlPath)
      fs.renameSync(stateYamlPath, bak)
      logger.info({ stateYamlPath, bak }, "Backed up legacy state.yaml")
    } catch (error) {
      logger.warn({ err: error, stateYamlPath }, "Failed to backup legacy state.yaml")
    }
  }

  if (shouldMigrateFromJson) {
    try {
      const bak = pickBackupPath(legacyJsonPath)
      fs.renameSync(legacyJsonPath, bak)
      logger.info({ legacyJsonPath, bak }, "Moved legacy config.json to backup")
    } catch (error) {
      logger.warn({ err: error, legacyJsonPath }, "Failed to move legacy config.json to backup")
    }
  }

  writeYaml(configYamlPath, config, logger)
  writeYaml(stateYamlPath, state, logger)

  logger.info({ configYamlPath, stateYamlPath }, "Migrated settings docs to owner-bucket layout")
}
