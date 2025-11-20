import fs from "fs"
import path from "path"
import { EventBus } from "../events/bus"
import { Logger } from "../logger"
import { ConfigFile, ConfigFileSchema, DEFAULT_CONFIG } from "./schema"

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
        this.logger.debug({ resolved }, "No config file found, using defaults")
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

  replace(config: ConfigFile) {
    const validated = ConfigFileSchema.parse(config)
    this.commit(validated)
  }

  private commit(next: ConfigFile) {
    this.cache = next
    this.loaded = true
    this.persist()
    this.eventBus?.publish({ type: "config.appChanged", config: this.cache })
    this.logger.info("Config updated")
    this.logger.debug({ config: this.cache }, "Config payload")
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
