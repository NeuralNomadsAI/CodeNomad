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
   * Get Era project status for a folder
   */
  getProjectStatus(folder: string): {
    initialized: boolean
    hasConstitution: boolean
    hasDirectives: boolean
  } {
    const eraDir = path.join(folder, ".era")
    const memoryDir = path.join(eraDir, "memory")

    return {
      initialized: this.isProjectInitialized(folder),
      hasConstitution: existsSync(path.join(memoryDir, "constitution.md")),
      hasDirectives: existsSync(path.join(memoryDir, "directives")) ||
                     existsSync(path.join(memoryDir, "directives.md")),
    }
  }
}
