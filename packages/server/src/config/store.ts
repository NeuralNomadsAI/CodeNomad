import fs from "fs"
import path from "path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { EventBus } from "../events/bus"
import { Logger } from "../logger"
import {
  ConfigFile,
  ConfigFileSchema,
  ConfigYamlSchema,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_YAML,
  DEFAULT_STATE,
  StateFile,
  StateFileSchema,
} from "./schema"
import type { ConfigLocation } from "./location"

export class ConfigStore {
  private cache: ConfigFile = DEFAULT_CONFIG
  private state: StateFile = DEFAULT_STATE
  private loaded = false

  constructor(
    private readonly location: ConfigLocation,
    private readonly eventBus: EventBus | undefined,
    private readonly logger: Logger,
  ) {}

  load(): ConfigFile {
    if (this.loaded) {
      return this.cache
    }

    try {
      const configYamlPath = this.location.configYamlPath
      const stateYamlPath = this.location.stateYamlPath
      const legacyJsonPath = this.location.legacyJsonPath

      if (fs.existsSync(configYamlPath)) {
        const configDoc = this.readYamlFile(configYamlPath, DEFAULT_CONFIG_YAML, ConfigYamlSchema, "config")
        const stateDoc = fs.existsSync(stateYamlPath)
          ? this.readYamlFile(stateYamlPath, DEFAULT_STATE, StateFileSchema, "state")
          : DEFAULT_STATE

        this.state = stateDoc
        this.cache = this.mergeDocs(configDoc, stateDoc)
        this.logger.debug({ configYamlPath, stateYamlPath }, "Loaded existing YAML config/state")
      } else if (fs.existsSync(legacyJsonPath)) {
        const migrated = this.migrateFromLegacyJson(legacyJsonPath)
        this.state = migrated.state
        this.cache = migrated.config
      } else {
        // Fresh install: write defaults.
        this.state = DEFAULT_STATE
        this.cache = this.mergeDocs(DEFAULT_CONFIG_YAML, DEFAULT_STATE)
        this.persist()
        this.logger.debug(
          { configYamlPath, stateYamlPath },
          "No config files found, created default YAML config/state",
        )
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to load config/state, using defaults")
      this.state = DEFAULT_STATE
      this.cache = this.mergeDocs(DEFAULT_CONFIG_YAML, DEFAULT_STATE)
    }

    this.loaded = true
    return this.cache
  }

  get(): ConfigFile {
    return this.load()
  }

  replace(config: ConfigFile) {
    const validated = ConfigFileSchema.parse(config)
    this.commit(validated)
  }

  /**
   * Apply a merge-patch update to the current config.
   * - Missing keys are preserved.
   * - Object values are merged recursively.
   * - Explicit `null` deletes keys.
   * - Arrays are replaced.
   */
  mergePatch(patch: unknown) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("Config patch must be a JSON object")
    }
    const current = this.get()
    const next = applyMergePatch(current as any, patch as any)
    const validated = ConfigFileSchema.parse(next)
    this.commit(validated)
  }

  private commit(next: ConfigFile) {
    this.cache = next
    this.loaded = true
    this.state = {
      ...this.state,
      recentFolders: next.recentFolders,
    }
    this.persist()
    const published = Boolean(this.eventBus)
    this.eventBus?.publish({ type: "config.appChanged", config: this.cache })
    this.logger.debug({ broadcast: published }, "Config SSE event emitted")
    this.logger.trace({ config: this.cache }, "Config payload")
  }

  private persist() {
    try {
      const configYamlPath = this.location.configYamlPath
      const stateYamlPath = this.location.stateYamlPath

      fs.mkdirSync(this.location.baseDir, { recursive: true })
      fs.mkdirSync(path.dirname(configYamlPath), { recursive: true })

      const configYaml = stringifyYaml(stripRecentFolders(this.cache) as any)
      const stateYaml = stringifyYaml(this.state as any)

      fs.writeFileSync(configYamlPath, ensureTrailingNewline(configYaml), "utf-8")
      fs.writeFileSync(stateYamlPath, ensureTrailingNewline(stateYaml), "utf-8")

      this.logger.debug({ configYamlPath, stateYamlPath }, "Persisted YAML config/state")
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to persist config")
    }
  }

  private mergeDocs(configDoc: unknown, stateDoc: StateFile): ConfigFile {
    const merged = {
      ...(configDoc as any),
      // State wins for recent folders.
      recentFolders: stateDoc.recentFolders ?? [],
    }

    return ConfigFileSchema.parse(merged)
  }

  private readYamlFile<T>(
    filePath: string,
    fallback: T,
    schema: { parse: (value: unknown) => T },
    label: string,
  ): T {
    try {
      const content = fs.readFileSync(filePath, "utf-8")
      const parsed = parseYaml(content)
      return schema.parse(parsed ?? {})
    } catch (error) {
      this.logger.warn({ err: error, filePath, label }, "Failed to read YAML file, using defaults")
      return fallback
    }
  }

  private migrateFromLegacyJson(legacyJsonPath: string): { config: ConfigFile; state: StateFile } {
    const configYamlPath = this.location.configYamlPath
    const stateYamlPath = this.location.stateYamlPath

    const content = fs.readFileSync(legacyJsonPath, "utf-8")
    const parsed = JSON.parse(content)
    const legacy = ConfigFileSchema.parse(parsed)

    const state: StateFile = StateFileSchema.parse({
      ...DEFAULT_STATE,
      recentFolders: legacy.recentFolders ?? [],
    })

    const merged = this.mergeDocs(stripRecentFolders(legacy), state)

    // Persist YAML docs first, then move legacy aside.
    try {
      fs.mkdirSync(this.location.baseDir, { recursive: true })
      fs.writeFileSync(configYamlPath, ensureTrailingNewline(stringifyYaml(stripRecentFolders(merged) as any)), "utf-8")
      fs.writeFileSync(stateYamlPath, ensureTrailingNewline(stringifyYaml(state as any)), "utf-8")
      this.logger.info({ legacyJsonPath, configYamlPath, stateYamlPath }, "Migrated config.json -> YAML")
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to persist migrated YAML config/state")
    }

    try {
      const bakPath = pickBackupPath(legacyJsonPath)
      fs.renameSync(legacyJsonPath, bakPath)
      this.logger.info({ legacyJsonPath, bakPath }, "Moved legacy config.json to backup")
    } catch (error) {
      this.logger.warn({ err: error, legacyJsonPath }, "Failed to rename legacy config.json to backup")
    }

    return { config: merged, state }
  }
}

function ensureTrailingNewline(content: string): string {
  if (!content) return "\n"
  return content.endsWith("\n") ? content : `${content}\n`
}

function stripRecentFolders(config: ConfigFile): Omit<ConfigFile, "recentFolders"> & Record<string, unknown> {
  const clone: Record<string, unknown> = { ...(config as any) }
  delete clone.recentFolders
  return clone as any
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function applyMergePatch(current: any, patch: any): any {
  // RFC 7396-ish merge patch with explicit null deletes.
  if (!isPlainObject(patch)) {
    return patch
  }

  const base = isPlainObject(current) ? { ...current } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key]
      continue
    }

    if (isPlainObject(value) && isPlainObject(base[key])) {
      base[key] = applyMergePatch(base[key], value)
      continue
    }

    // Arrays and scalars replace.
    base[key] = value
  }
  return base
}

function pickBackupPath(legacyJsonPath: string): string {
  const base = legacyJsonPath.endsWith(".json") ? legacyJsonPath.slice(0, -".json".length) : legacyJsonPath
  const preferred = `${base}.json.bak`
  if (!fs.existsSync(preferred)) {
    return preferred
  }
  return `${base}.json.bak.${Date.now()}`
}
