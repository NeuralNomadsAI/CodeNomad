import { execSync } from "child_process"
import type { Logger } from "../logger"
import type { EraDetectionService } from "./detection"

/**
 * A governance rule with its category context
 */
export interface GovernanceRule {
  id: string
  action: "allow" | "deny"
  source: "default" | "global" | "project" | "local" | "hardcoded"
  isOverridden: boolean
}

/**
 * A category of governance rules
 */
export interface GovernanceCategory {
  categoryId: string
  categoryName: string
  rules: GovernanceRule[]
}

/**
 * A setting value with its source
 */
export interface GovernanceSetting {
  value: boolean | string
  source: "default" | "global" | "project" | "local"
}

/**
 * Config file paths
 */
export interface GovernanceConfigPaths {
  global: string
  project: string
  local: string
}

/**
 * Full governance configuration from era-code config --list --json
 */
export interface GovernanceConfig {
  settings: {
    audit_mode: GovernanceSetting
    default_agent: GovernanceSetting
    [key: string]: GovernanceSetting
  }
  rules: GovernanceCategory[]
  configPaths: GovernanceConfigPaths
}

/**
 * Result of setting a governance rule
 */
export interface GovernanceSetResult {
  scope: "global" | "project" | "local"
  action: "set"
  value: boolean
}

/**
 * Result of getting a governance value
 */
export interface GovernanceGetResult {
  key: string
  value: string
}

/**
 * Service for managing era-code governance configuration
 */
export class EraGovernanceService {
  constructor(
    private readonly detection: EraDetectionService,
    private readonly logger: Logger
  ) {}

  /**
   * Get full governance configuration for a folder
   */
  getConfig(folder?: string): { success: true; config: GovernanceConfig } | { success: false; error: string } {
    const binaryInfo = this.detection.detectBinary()

    if (!binaryInfo.installed || !binaryInfo.path) {
      return {
        success: false,
        error: "era-code is not installed",
      }
    }

    try {
      const result = execSync(`"${binaryInfo.path}" config --list --json`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
        cwd: folder || process.cwd(),
      })

      const config = JSON.parse(result.trim()) as GovernanceConfig

      this.logger.debug(
        {
          folder,
          categoryCount: config.rules.length,
          ruleCount: config.rules.reduce((sum, cat) => sum + cat.rules.length, 0),
        },
        "Got governance config"
      )

      return { success: true, config }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      this.logger.error({ error, folder }, "Error getting governance config")
      return { success: false, error: message }
    }
  }

  /**
   * Get a specific governance rule or setting value
   */
  getValue(
    key: string,
    folder?: string
  ): { success: true; key: string; value: string } | { success: false; error: string } {
    const binaryInfo = this.detection.detectBinary()

    if (!binaryInfo.installed || !binaryInfo.path) {
      return {
        success: false,
        error: "era-code is not installed",
      }
    }

    try {
      const result = execSync(`"${binaryInfo.path}" config --get "${key}" --json`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
        cwd: folder || process.cwd(),
      })

      const data = JSON.parse(result.trim()) as GovernanceGetResult

      this.logger.debug({ key, value: data.value, folder }, "Got governance value")

      return { success: true, key: data.key, value: data.value }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      this.logger.error({ error, key, folder }, "Error getting governance value")
      return { success: false, error: message }
    }
  }

  /**
   * Set a governance rule or setting
   * @param key - The key to set (e.g., "rules.kubectl-apply" or "settings.audit_mode")
   * @param value - The value to set (e.g., "allow", "deny", "true", "false")
   * @param scope - Where to save: "global", "project", or "local"
   * @param folder - The folder context (required for project/local scope)
   */
  setValue(
    key: string,
    value: string,
    scope: "global" | "project" | "local" = "project",
    folder?: string
  ): { success: true; result: GovernanceSetResult } | { success: false; error: string } {
    const binaryInfo = this.detection.detectBinary()

    if (!binaryInfo.installed || !binaryInfo.path) {
      return {
        success: false,
        error: "era-code is not installed",
      }
    }

    // Build the scope flag
    let scopeFlag = ""
    if (scope === "global") {
      scopeFlag = "--global"
    } else if (scope === "local") {
      scopeFlag = "--local"
    }
    // project is the default, no flag needed

    try {
      const cmd = `"${binaryInfo.path}" config --set "${key}=${value}" ${scopeFlag} --json`.trim()

      const result = execSync(cmd, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
        cwd: folder || process.cwd(),
      })

      const data = JSON.parse(result.trim()) as GovernanceSetResult

      this.logger.info({ key, value, scope, folder }, "Set governance value")

      return { success: true, result: data }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      this.logger.error({ error, key, value, scope, folder }, "Error setting governance value")
      return { success: false, error: message }
    }
  }

  /**
   * Set a rule action (convenience method)
   */
  setRuleAction(
    ruleId: string,
    action: "allow" | "deny",
    scope: "global" | "project" | "local" = "project",
    folder?: string
  ): { success: true; result: GovernanceSetResult } | { success: false; error: string } {
    return this.setValue(`rules.${ruleId}`, action, scope, folder)
  }

  /**
   * Get a summary of governance for quick display
   */
  getSummary(folder?: string): {
    success: true
    summary: {
      totalRules: number
      overriddenRules: number
      auditMode: boolean
      defaultAgent: string
    }
  } | { success: false; error: string } {
    const configResult = this.getConfig(folder)

    if (!configResult.success) {
      return configResult
    }

    const config = configResult.config
    let totalRules = 0
    let overriddenRules = 0

    for (const category of config.rules) {
      for (const rule of category.rules) {
        totalRules++
        if (rule.isOverridden) {
          overriddenRules++
        }
      }
    }

    return {
      success: true,
      summary: {
        totalRules,
        overriddenRules,
        auditMode: config.settings.audit_mode?.value === true,
        defaultAgent: String(config.settings.default_agent?.value ?? "orchestration"),
      },
    }
  }
}
