import { execSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import path from "path"
import os from "os"
import type { Logger } from "../logger"

/**
 * Information about the era-code binary installation
 */
export interface EraBinaryInfo {
  installed: boolean
  path: string | null
  version: string | null
  assetsPath: string | null
}

/**
 * Information about available era-code upgrade
 */
export interface EraUpgradeInfo {
  available: boolean
  currentVersion: string | null
  targetVersion: string | null
  error?: string
}

/**
 * Era assets available for OpenCode integration
 */
export interface EraAssets {
  agents: string[]
  commands: string[]
  skills: string[]
  plugins: string[]
}

/**
 * Era manifest file structure
 */
interface EraManifest {
  version: string
  installedAt: string
  files: string[]
}

/**
 * Era project status from `era-code status --json`
 */
export interface EraProjectStatus {
  initialized: boolean
  toolStatus: Array<{
    id: string
    name: string
    configured: boolean
  }>
  manifest?: {
    version: string
    latestVersion: string
    initializedDate: string
    lastUpdatedDate: string
    tools: string[]
    features: {
      directives: boolean
      workflows: boolean
    }
  }
  directives?: {
    categoryCount: number
    categories: string[]
    directiveCount: number
  }
  syncStatus?: {
    behindMain: boolean
    behindCount: number
  }
  mcpServers?: Array<{
    id: string
    name: string
    enabled: boolean
  }>
}

/**
 * Result of era-code init --json
 */
export interface EraInitResult {
  projectPath: string
  extendMode: boolean
  selectedTools: string[]
  mcpServers: string[]
}

/**
 * Service for detecting era-code installation and configuration
 */
export class EraDetectionService {
  private readonly eraConfigDir: string
  private readonly eraAssetsDir: string

  constructor(private readonly logger: Logger) {
    this.eraConfigDir = path.join(os.homedir(), ".era", "era-code")
    this.eraAssetsDir = path.join(this.eraConfigDir, "opencode")
  }

  /**
   * Detect if era-code is installed and get its path
   */
  detectBinary(): EraBinaryInfo {
    try {
      // Try to find era-code in PATH
      const binaryPath = this.findBinaryPath()
      if (!binaryPath) {
        this.logger.debug("era-code binary not found in PATH")
        return {
          installed: false,
          path: null,
          version: null,
          assetsPath: null,
        }
      }

      // Get version
      const version = this.getVersion(binaryPath)

      // Get assets path
      const assetsPath = this.getAssetsPath()

      this.logger.debug(
        { path: binaryPath, version, assetsPath },
        "era-code binary detected"
      )

      return {
        installed: true,
        path: binaryPath,
        version,
        assetsPath,
      }
    } catch (error) {
      this.logger.debug({ error }, "Error detecting era-code binary")
      return {
        installed: false,
        path: null,
        version: null,
        assetsPath: null,
      }
    }
  }

  /**
   * Find the era-code binary path
   */
  private findBinaryPath(): string | null {
    try {
      const command = process.platform === "win32" ? "where era-code" : "which era-code"
      const result = execSync(command, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
      const binaryPath = result.trim().split("\n")[0]

      if (binaryPath && existsSync(binaryPath)) {
        return binaryPath
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * Get era-code version from the binary
   */
  getVersion(binaryPath: string): string | null {
    try {
      const result = execSync(`"${binaryPath}" --version`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      })
      const version = result.trim()
      // Version should be like "3.0.0"
      if (/^\d+\.\d+\.\d+/.test(version)) {
        return version
      }
      return version || null
    } catch {
      return null
    }
  }

  /**
   * Get path to era assets directory
   */
  getAssetsPath(): string | null {
    if (existsSync(this.eraAssetsDir)) {
      return this.eraAssetsDir
    }
    return null
  }

  /**
   * Read the era manifest file
   */
  private readManifest(): EraManifest | null {
    const manifestPath = path.join(this.eraConfigDir, "manifest.json")
    try {
      if (!existsSync(manifestPath)) {
        return null
      }
      const content = readFileSync(manifestPath, "utf-8")
      return JSON.parse(content) as EraManifest
    } catch (error) {
      this.logger.debug({ error, path: manifestPath }, "Error reading era manifest")
      return null
    }
  }

  /**
   * List available era assets from manifest
   */
  listAssets(): EraAssets | null {
    const manifest = this.readManifest()
    if (!manifest) {
      return null
    }

    const assets: EraAssets = {
      agents: [],
      commands: [],
      skills: [],
      plugins: [],
    }

    for (const filePath of manifest.files) {
      const relativePath = filePath.replace(this.eraAssetsDir + "/", "")

      if (relativePath.startsWith("agent/") && relativePath.endsWith(".md")) {
        assets.agents.push(filePath)
      } else if (relativePath.startsWith("command/") && relativePath.endsWith(".md")) {
        assets.commands.push(filePath)
      } else if (relativePath.startsWith("skill/") && relativePath.includes("/SKILL.md")) {
        // Skills are in subdirectories with SKILL.md
        const skillDir = path.dirname(filePath)
        if (!assets.skills.includes(skillDir)) {
          assets.skills.push(skillDir)
        }
      } else if (relativePath.startsWith("plugin/") && relativePath.endsWith(".ts")) {
        assets.plugins.push(filePath)
      }
    }

    this.logger.debug(
      {
        agents: assets.agents.length,
        commands: assets.commands.length,
        skills: assets.skills.length,
        plugins: assets.plugins.length,
      },
      "Era assets loaded"
    )

    return assets
  }

  /**
   * Check if a project has Era initialized (has .era directory)
   */
  isProjectInitialized(folder: string): boolean {
    const eraDir = path.join(folder, ".era")
    const manifestPath = path.join(eraDir, "manifest.json")
    const memoryDir = path.join(eraDir, "memory")

    // Check for .era directory with expected structure
    return existsSync(eraDir) && (existsSync(manifestPath) || existsSync(memoryDir))
  }

  /**
   * Get Era project status for a folder using era-code status --json
   */
  getProjectStatus(folder: string): EraProjectStatus | null {
    const binaryInfo = this.detectBinary()
    
    if (!binaryInfo.installed || !binaryInfo.path) {
      // Fallback to file-based check if binary not available
      const eraDir = path.join(folder, ".era")
      const memoryDir = path.join(eraDir, "memory")
      
      return {
        initialized: this.isProjectInitialized(folder),
        toolStatus: [],
      }
    }

    try {
      const result = execSync(`"${binaryInfo.path}" status --json`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
        cwd: folder,
      })

      const data = JSON.parse(result.trim()) as EraProjectStatus
      
      this.logger.debug(
        { folder, initialized: data.initialized, manifestVersion: data.manifest?.version },
        "Got era project status"
      )
      
      return data
    } catch (error) {
      this.logger.debug({ error, folder }, "Error getting era project status")
      // Fallback to basic file check
      return {
        initialized: this.isProjectInitialized(folder),
        toolStatus: [],
      }
    }
  }

  /**
   * Check if an era-code upgrade is available
   */
  checkUpgrade(): EraUpgradeInfo {
    const binaryInfo = this.detectBinary()
    
    if (!binaryInfo.installed || !binaryInfo.path) {
      return {
        available: false,
        currentVersion: null,
        targetVersion: null,
        error: "era-code is not installed",
      }
    }

    try {
      // Run era-code upgrade --check --json
      const result = execSync(`"${binaryInfo.path}" upgrade --check --json`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      })

      const data = JSON.parse(result.trim()) as {
        currentVersion: string
        latestVersion: string
        upgraded: boolean
      }

      const available = data.currentVersion !== data.latestVersion
      
      if (available) {
        this.logger.info(
          { currentVersion: data.currentVersion, targetVersion: data.latestVersion },
          "Era-code upgrade available"
        )
      }

      return {
        available,
        currentVersion: data.currentVersion,
        targetVersion: available ? data.latestVersion : null,
      }
    } catch (error) {
      this.logger.debug({ error }, "Error checking for era-code upgrade")
      return {
        available: false,
        currentVersion: binaryInfo.version,
        targetVersion: null,
        error: error instanceof Error ? error.message : "Unknown error",
      }
    }
  }

  /**
   * Run era-code upgrade
   */
  async runUpgrade(): Promise<{ success: boolean; version?: string; error?: string }> {
    const binaryInfo = this.detectBinary()
    
    if (!binaryInfo.installed || !binaryInfo.path) {
      return {
        success: false,
        error: "era-code is not installed",
      }
    }

    try {
      this.logger.info("Running era-code upgrade")
      
      // Run era-code upgrade --json
      const result = execSync(`"${binaryInfo.path}" upgrade --json`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000, // 2 minutes timeout for upgrade
      })

      const data = JSON.parse(result.trim()) as {
        currentVersion: string
        latestVersion: string
        upgraded: boolean
      }
      
      this.logger.info(
        { upgraded: data.upgraded, version: data.currentVersion },
        "Era-code upgrade completed"
      )
      
      return {
        success: true,
        version: data.currentVersion,
      }
    } catch (error) {
      this.logger.error({ error }, "Error running era-code upgrade")
      return {
        success: false,
        error: error instanceof Error ? error.message : "Upgrade failed",
      }
    }
  }

  /**
   * Check if a project's manifest is outdated compared to the installed era-code version
   */
  isProjectOutdated(folder: string): { outdated: boolean; currentVersion?: string; latestVersion?: string } {
    const status = this.getProjectStatus(folder)
    
    if (!status?.initialized || !status.manifest) {
      return { outdated: false }
    }

    const outdated = status.manifest.version !== status.manifest.latestVersion
    
    return {
      outdated,
      currentVersion: status.manifest.version,
      latestVersion: status.manifest.latestVersion,
    }
  }

  /**
   * Update a project's era manifest by running era-code init
   * This brings the manifest up to the current era-code version
   */
  async updateProjectManifest(folder: string): Promise<{ success: boolean; error?: string }> {
    const binaryInfo = this.detectBinary()
    
    if (!binaryInfo.installed || !binaryInfo.path) {
      return {
        success: false,
        error: "era-code is not installed",
      }
    }

    try {
      this.logger.info({ folder }, "Updating era project manifest")
      
      const result = execSync(`"${binaryInfo.path}" init --json`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
        cwd: folder,
      })

      const data = JSON.parse(result.trim()) as EraInitResult
      
      this.logger.info(
        { folder, tools: data.selectedTools },
        "Era project manifest updated"
      )
      
      return { success: true }
    } catch (error) {
      this.logger.error({ error, folder }, "Error updating era project manifest")
      return {
        success: false,
        error: error instanceof Error ? error.message : "Update failed",
      }
    }
  }

  /**
   * Check and auto-update project manifest if outdated
   * Returns info about what was done
   */
  async ensureProjectUpToDate(folder: string): Promise<{
    wasOutdated: boolean
    updated: boolean
    previousVersion?: string
    currentVersion?: string
    error?: string
  }> {
    const outdatedInfo = this.isProjectOutdated(folder)
    
    if (!outdatedInfo.outdated) {
      return { wasOutdated: false, updated: false }
    }

    this.logger.info(
      { folder, from: outdatedInfo.currentVersion, to: outdatedInfo.latestVersion },
      "Project manifest is outdated, updating..."
    )

    const updateResult = await this.updateProjectManifest(folder)
    
    if (!updateResult.success) {
      return {
        wasOutdated: true,
        updated: false,
        previousVersion: outdatedInfo.currentVersion,
        error: updateResult.error,
      }
    }

    return {
      wasOutdated: true,
      updated: true,
      previousVersion: outdatedInfo.currentVersion,
      currentVersion: outdatedInfo.latestVersion,
    }
  }
}
