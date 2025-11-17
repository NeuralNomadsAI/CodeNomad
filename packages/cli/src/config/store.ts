import fs from "fs"
import path from "path"
import { EventBus } from "../events/bus"
import { Logger } from "../logger"
import {
  AgentModelSelections,
  ConfigFile,
  ConfigFileUpdate,
  ConfigFileSchema,
  ConfigFileUpdateSchema,
  DEFAULT_CONFIG,
} from "./schema"

export class ConfigStore {
  private cache: ConfigFile = DEFAULT_CONFIG
  private loaded = false

  constructor(
    private readonly configPath: string,
    private readonly eventBus: EventBus | undefined,
    private readonly logger: Logger,
  ) {}

  load(): ConfigFile {
    if (this.loaded) {
      return this.cache
    }

    try {
      const resolved = this.resolvePath(this.configPath)
      if (fs.existsSync(resolved)) {
        const content = fs.readFileSync(resolved, "utf-8")
        const parsed = JSON.parse(content)
        this.cache = ConfigFileSchema.parse(parsed)
        this.logger.debug({ resolved }, "Loaded existing config file")
      } else {
        this.cache = DEFAULT_CONFIG
        this.logger.info({ resolved }, "No config file found, using defaults")
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to load config, using defaults")
      this.cache = DEFAULT_CONFIG
    }

    this.loaded = true
    return this.cache
  }

  get(): ConfigFile {
    return this.load()
  }

  update(partial: ConfigFile | ConfigFileUpdate) {
    const safePartial =
      "recentFolders" in partial && "opencodeBinaries" in partial
        ? ConfigFileSchema.parse(partial)
        : ConfigFileUpdateSchema.parse(partial ?? {})
    const merged = this.mergeConfig(this.load(), safePartial)
    this.cache = ConfigFileSchema.parse(merged)
    this.persist()
    this.eventBus?.publish({ type: "config.appChanged", config: this.cache })
    this.logger.info("Config updated")
  }

  private mergeConfig(current: ConfigFile, partial: ConfigFile | ConfigFileUpdate): ConfigFile {
    const mergedPreferences = {
      ...current.preferences,
      ...partial.preferences,
      environmentVariables: {
        ...current.preferences.environmentVariables,
        ...(partial.preferences?.environmentVariables ?? {}),
      },
      agentModelSelections: this.mergeAgentSelections(
        current.preferences.agentModelSelections,
        partial.preferences?.agentModelSelections,
      ),
    }

    return {
      ...current,
      ...partial,
      preferences: mergedPreferences,
      recentFolders: partial.recentFolders ?? current.recentFolders,
      opencodeBinaries: partial.opencodeBinaries ?? current.opencodeBinaries,
    }
  }

  private mergeAgentSelections(base: AgentModelSelections, update?: AgentModelSelections) {
    if (!update) {
      return base
    }

    const result: AgentModelSelections = { ...base }
    for (const [instanceId, agentMap] of Object.entries(update)) {
      result[instanceId] = {
        ...(base[instanceId] ?? {}),
        ...agentMap,
      }
    }
    return result
  }

  private persist() {
    try {
      const resolved = this.resolvePath(this.configPath)
      fs.mkdirSync(path.dirname(resolved), { recursive: true })
      fs.writeFileSync(resolved, JSON.stringify(this.cache, null, 2), "utf-8")
      this.logger.debug({ resolved }, "Persisted config file")
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to persist config")
    }
  }

  private resolvePath(filePath: string) {
    if (filePath.startsWith("~/")) {
      return path.join(process.env.HOME ?? "", filePath.slice(2))
    }
    return path.resolve(filePath)
  }
}
