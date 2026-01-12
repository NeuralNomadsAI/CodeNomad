import path from "path"
import type { Logger } from "../logger"
import { EraDetectionService, type EraAssets } from "./detection"

/**
 * Configuration for launching a workspace with Era features
 */
export interface EraLaunchConfig {
  enabled: boolean
  assetsPath: string
  plugins: string[]
  agents: string[]
  commands: string[]
  skills: string[]
}

/**
 * Service for building Era launch configurations
 */
export class EraConfigService {
  constructor(
    private readonly detection: EraDetectionService,
    private readonly logger: Logger,
  ) {}

  /**
   * Build launch configuration for a workspace
   * Returns null if era-code is not installed or assets unavailable
   */
  buildLaunchConfig(folder: string): EraLaunchConfig | null {
    const binaryInfo = this.detection.detectBinary()

    if (!binaryInfo.installed) {
      this.logger.debug("Era launch config unavailable: era-code not installed")
      return null
    }

    const assetsPath = this.detection.getAssetsPath()
    if (!assetsPath) {
      this.logger.debug("Era launch config unavailable: assets path not found")
      return null
    }

    const assets = this.detection.listAssets()
    if (!assets) {
      this.logger.debug("Era launch config unavailable: could not list assets")
      return null
    }

    const config: EraLaunchConfig = {
      enabled: true,
      assetsPath,
      plugins: assets.plugins,
      agents: assets.agents,
      commands: assets.commands,
      skills: assets.skills,
    }

    this.logger.debug(
      {
        folder,
        assetsPath,
        pluginCount: assets.plugins.length,
        agentCount: assets.agents.length,
        commandCount: assets.commands.length,
        skillCount: assets.skills.length,
      },
      "Built Era launch config"
    )

    return config
  }

  /**
   * Get environment variables for era-enabled launch
   * These configure OpenCode to use era's custom assets
   */
  getLaunchEnvironment(config: EraLaunchConfig): Record<string, string> {
    const env: Record<string, string> = {}

    // Set paths for OpenCode to discover era assets
    // These environment variables are used by OpenCode to load custom agents, commands, etc.
    if (config.assetsPath) {
      env.OPENCODE_AGENT_PATH = path.join(config.assetsPath, "agent")
      env.OPENCODE_COMMAND_PATH = path.join(config.assetsPath, "command")
      env.OPENCODE_SKILL_PATH = path.join(config.assetsPath, "skill")
      env.OPENCODE_PLUGIN_PATH = path.join(config.assetsPath, "plugin")
    }

    // Mark this as an era-enabled session
    env.ERA_CODE_ENABLED = "true"
    env.ERA_CODE_VERSION = this.detection.detectBinary().version ?? "unknown"

    return env
  }

  /**
   * Check if Era features should be enabled for a workspace
   */
  shouldEnableEra(folder: string): boolean {
    const binaryInfo = this.detection.detectBinary()
    if (!binaryInfo.installed) {
      return false
    }

    // Enable for all projects when era-code is installed
    // Project-specific features (governance, directives) will check .era/ directory
    return true
  }

  /**
   * Get summary of era configuration for logging/display
   */
  getConfigSummary(): {
    installed: boolean
    version: string | null
    assetsAvailable: boolean
    assetCounts: { agents: number; commands: number; skills: number; plugins: number } | null
  } {
    const binaryInfo = this.detection.detectBinary()
    const assets = this.detection.listAssets()

    return {
      installed: binaryInfo.installed,
      version: binaryInfo.version,
      assetsAvailable: assets !== null,
      assetCounts: assets ? {
        agents: assets.agents.length,
        commands: assets.commands.length,
        skills: assets.skills.length,
        plugins: assets.plugins.length,
      } : null,
    }
  }
}
