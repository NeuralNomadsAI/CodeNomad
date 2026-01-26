import { FastifyInstance } from "fastify"
import type { EraStatusResponse, UpdateCheckResult } from "../../api-types"
import type { EraDetectionService } from "../../era/detection"
import type { EraGovernanceService } from "../../era/governance"
import type { UpdateMonitor } from "../../updates/update-monitor"
import type { Logger } from "../../logger"

interface RouteDeps {
  eraDetection: EraDetectionService
  eraGovernance: EraGovernanceService
  updateMonitor?: UpdateMonitor
  logger: Logger
}

export function registerEraRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { eraDetection, eraGovernance, updateMonitor, logger } = deps

  /**
   * GET /api/era/status
   * Returns the era-code installation status and project initialization state
   */
  app.get<{
    Querystring: { folder?: string }
  }>("/api/era/status", async (request) => {
    const folder = request.query.folder

    logger.debug({ folder }, "Checking Era status")

    const binaryInfo = eraDetection.detectBinary()
    const assets = eraDetection.listAssets()

    const response: EraStatusResponse = {
      installed: binaryInfo.installed,
      version: binaryInfo.version,
      binaryPath: binaryInfo.path,
      projectInitialized: folder ? eraDetection.isProjectInitialized(folder) : false,
      assetsAvailable: assets !== null,
    }

    // Add asset counts if available
    if (assets) {
      response.assets = {
        agents: assets.agents.length,
        commands: assets.commands.length,
        skills: assets.skills.length,
        plugins: assets.plugins.length,
      }
    }

    // Add project-specific status if folder provided
    if (folder && response.projectInitialized) {
      const projectStatus = eraDetection.getProjectStatus(folder)
      if (projectStatus) {
        response.project = {
          hasConstitution: (projectStatus.directives?.categoryCount ?? 0) > 0,
          hasDirectives: (projectStatus.directives?.directiveCount ?? 0) > 0,
        }
        // Add manifest version info for outdated detection
        if (projectStatus.manifest) {
          response.manifestVersion = projectStatus.manifest.version
          response.latestVersion = projectStatus.manifest.latestVersion
          response.isManifestOutdated = projectStatus.manifest.version !== projectStatus.manifest.latestVersion
        }
      }
    }

    logger.debug(
      {
        installed: response.installed,
        version: response.version,
        projectInitialized: response.projectInitialized,
      },
      "Era status response"
    )

    return response
  })

  /**
   * GET /api/era/assets
   * Returns detailed information about available era assets
   */
  app.get("/api/era/assets", async () => {
    const binaryInfo = eraDetection.detectBinary()

    if (!binaryInfo.installed) {
      return {
        available: false,
        reason: "era-code is not installed",
      }
    }

    const assets = eraDetection.listAssets()

    if (!assets) {
      return {
        available: false,
        reason: "Era assets not found",
      }
    }

    return {
      available: true,
      assetsPath: binaryInfo.assetsPath,
      agents: assets.agents.map((p) => extractAssetName(p, "agent")),
      commands: assets.commands.map((p) => extractAssetName(p, "command")),
      skills: assets.skills.map((p) => extractSkillName(p)),
      plugins: assets.plugins.map((p) => extractAssetName(p, "plugin")),
    }
  })

  /**
   * GET /api/era/upgrade/check
   * Check if an era-code upgrade is available
   */
  app.get("/api/era/upgrade/check", async () => {
    logger.debug("Checking for era-code upgrade")
    return eraDetection.checkUpgrade()
  })

  /**
   * POST /api/era/upgrade
   * Run era-code upgrade
   */
  app.post("/api/era/upgrade", async () => {
    logger.info("Running era-code upgrade via API")
    return eraDetection.runUpgrade()
  })

  /**
   * POST /api/era/project/update
   * Update project manifest to current era-code version (runs era-code init)
   */
  app.post<{
    Body: { folder: string }
  }>("/api/era/project/update", async (request, reply) => {
    const { folder } = request.body ?? {}

    if (!folder) {
      reply.code(400)
      return { error: "folder is required" }
    }

    logger.info({ folder }, "Updating era project manifest via API")
    return eraDetection.ensureProjectUpToDate(folder)
  })

  // ============================================================================
  // UPDATE CHECK ROUTES
  // ============================================================================

  /**
   * GET /api/updates/check
   * Manually trigger an update check for Era Code and OpenCode
   */
  app.get("/api/updates/check", async (request, reply): Promise<UpdateCheckResult | { error: string }> => {
    if (!updateMonitor) {
      reply.code(503)
      return { error: "Update monitor not available" }
    }

    logger.debug("Manual update check triggered")
    return updateMonitor.checkNow()
  })

  /**
   * GET /api/updates/status
   * Get the last update check result without triggering a new check
   */
  app.get("/api/updates/status", async (request, reply): Promise<UpdateCheckResult | { lastChecked: null }> => {
    if (!updateMonitor) {
      return { lastChecked: null } as { lastChecked: null }
    }

    const result = updateMonitor.getLastResult()
    if (!result) {
      return { lastChecked: null } as { lastChecked: null }
    }
    return result
  })

  // ============================================================================
  // GOVERNANCE ROUTES
  // ============================================================================

  /**
   * GET /api/era/governance/config
   * Get full governance configuration (rules, settings, paths)
   */
  app.get<{
    Querystring: { folder?: string }
  }>("/api/era/governance/config", async (request) => {
    const folder = request.query.folder
    logger.debug({ folder }, "Getting governance config")
    return eraGovernance.getConfig(folder)
  })

  /**
   * GET /api/era/governance/summary
   * Get governance summary for quick display
   */
  app.get<{
    Querystring: { folder?: string }
  }>("/api/era/governance/summary", async (request) => {
    const folder = request.query.folder
    logger.debug({ folder }, "Getting governance summary")
    return eraGovernance.getSummary(folder)
  })

  /**
   * GET /api/era/governance/rules
   * Get all governance rules (flattened from categories)
   * This is for backward compatibility with existing UI expectations
   */
  app.get<{
    Querystring: { folder?: string }
  }>("/api/era/governance/rules", async (request) => {
    const folder = request.query.folder
    logger.debug({ folder }, "Getting governance rules")

    const result = eraGovernance.getConfig(folder)
    if (!result.success) {
      return { success: false, error: result.error, rules: [] }
    }

    // Flatten categories into a single rules array with category info
    const rules = result.config.rules.flatMap((category) =>
      category.rules.map((rule) => ({
        id: rule.id,
        categoryId: category.categoryId,
        categoryName: category.categoryName,
        action: rule.action,
        source: rule.source,
        isOverridden: rule.isOverridden,
        // Add legacy fields for UI compatibility
        pattern: rule.id, // The rule id is essentially the pattern
        reason: `${category.categoryName} operation`,
        overridable: rule.source !== "hardcoded",
      }))
    )

    return { success: true, rules }
  })

  /**
   * PUT /api/era/governance/rule
   * Set a governance rule action
   */
  app.put<{
    Body: {
      ruleId: string
      action: "allow" | "deny"
      scope?: "global" | "project" | "local"
      folder?: string
    }
  }>("/api/era/governance/rule", async (request, reply) => {
    const { ruleId, action, scope = "project", folder } = request.body ?? {}

    if (!ruleId) {
      reply.code(400)
      return { success: false, error: "ruleId is required" }
    }

    if (!action || !["allow", "deny"].includes(action)) {
      reply.code(400)
      return { success: false, error: "action must be 'allow' or 'deny'" }
    }

    logger.info({ ruleId, action, scope, folder }, "Setting governance rule")
    return eraGovernance.setRuleAction(ruleId, action, scope, folder)
  })

  /**
   * PUT /api/era/governance/setting
   * Set a governance setting
   */
  app.put<{
    Body: {
      key: string
      value: string
      scope?: "global" | "project" | "local"
      folder?: string
    }
  }>("/api/era/governance/setting", async (request, reply) => {
    const { key, value, scope = "project", folder } = request.body ?? {}

    if (!key) {
      reply.code(400)
      return { success: false, error: "key is required" }
    }

    if (value === undefined) {
      reply.code(400)
      return { success: false, error: "value is required" }
    }

    logger.info({ key, value, scope, folder }, "Setting governance setting")
    return eraGovernance.setValue(`settings.${key}`, value, scope, folder)
  })

  /**
   * GET /api/era/governance/value
   * Get a specific governance value
   */
  app.get<{
    Querystring: { key: string; folder?: string }
  }>("/api/era/governance/value", async (request, reply) => {
    const { key, folder } = request.query

    if (!key) {
      reply.code(400)
      return { success: false, error: "key is required" }
    }

    logger.debug({ key, folder }, "Getting governance value")
    return eraGovernance.getValue(key, folder)
  })

  /**
   * PUT /api/era/governance/override (legacy endpoint for UI compatibility)
   * Set a rule override - maps to setRuleAction with action="allow"
   */
  app.put<{
    Body: {
      ruleId: string
      action: "allow" | "deny"
      justification?: string
      folder: string
    }
  }>("/api/era/governance/override", async (request, reply) => {
    const { ruleId, action, folder } = request.body ?? {}

    if (!ruleId) {
      reply.code(400)
      return { success: false, error: "ruleId is required" }
    }

    if (!folder) {
      reply.code(400)
      return { success: false, error: "folder is required" }
    }

    logger.info({ ruleId, action, folder }, "Setting governance override (legacy)")
    const result = eraGovernance.setRuleAction(ruleId, action, "project", folder)
    return result.success ? { success: true } : result
  })

  /**
   * DELETE /api/era/governance/override (legacy endpoint for UI compatibility)
   * Remove a rule override - maps to setRuleAction with action="deny"
   */
  app.delete<{
    Body: {
      ruleId: string
      folder: string
    }
  }>("/api/era/governance/override", async (request, reply) => {
    const { ruleId, folder } = request.body ?? {}

    if (!ruleId) {
      reply.code(400)
      return { success: false, error: "ruleId is required" }
    }

    if (!folder) {
      reply.code(400)
      return { success: false, error: "folder is required" }
    }

    logger.info({ ruleId, folder }, "Removing governance override (legacy)")
    const result = eraGovernance.setRuleAction(ruleId, "deny", "project", folder)
    return result.success ? { success: true } : result
  })

  // ============================================================================
  // DIRECTIVES ROUTES
  // ============================================================================

  /**
   * GET /api/era/directives
   * Get directives file content (global or project)
   */
  app.get<{
    Querystring: { type?: "global" | "project"; folder?: string }
  }>("/api/era/directives", async (request) => {
    const { type = "global", folder } = request.query

    logger.debug({ type, folder }, "Getting directives")

    if (type === "global") {
      // Global directives are in ~/.era/memory/directives.md
      const homedir = process.env.HOME || process.env.USERPROFILE || "~"
      const globalPath = `${homedir}/.era/memory/directives.md`

      try {
        const fs = await import("fs/promises")
        const content = await fs.readFile(globalPath, "utf-8")
        return {
          success: true,
          content,
          path: globalPath,
          exists: true,
          hash: Buffer.from(content).toString("base64").slice(0, 16),
        }
      } catch {
        return {
          success: true,
          content: "",
          path: globalPath,
          exists: false,
          hash: "",
        }
      }
    }

    // Project directives
    if (!folder) {
      return { success: false, error: "folder is required for project directives" }
    }

    const projectPath = `${folder}/.era/memory/directives.md`

    try {
      const fs = await import("fs/promises")
      const content = await fs.readFile(projectPath, "utf-8")
      return {
        success: true,
        content,
        path: projectPath,
        exists: true,
        hash: Buffer.from(content).toString("base64").slice(0, 16),
      }
    } catch {
      return {
        success: true,
        content: "",
        path: projectPath,
        exists: false,
        hash: "",
      }
    }
  })

  /**
   * POST /api/era/directives
   * Save directives file content
   */
  app.post<{
    Body: { type?: "global" | "project"; folder?: string; content: string }
  }>("/api/era/directives", async (request, reply) => {
    const { type = "project", folder, content } = request.body ?? {}

    logger.info({ type, folder }, "Saving directives")

    if (content === undefined) {
      reply.code(400)
      return { success: false, error: "content is required" }
    }

    let targetPath: string

    if (type === "global") {
      const homedir = process.env.HOME || process.env.USERPROFILE || "~"
      targetPath = `${homedir}/.era/memory/directives.md`
    } else {
      if (!folder) {
        reply.code(400)
        return { success: false, error: "folder is required for project directives" }
      }
      targetPath = `${folder}/.era/memory/directives.md`
    }

    try {
      const fs = await import("fs/promises")
      const path = await import("path")

      // Ensure directory exists
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, content, "utf-8")

      return {
        success: true,
        path: targetPath,
        hash: Buffer.from(content).toString("base64").slice(0, 16),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      logger.error({ error, targetPath }, "Error saving directives")
      return { success: false, error: message }
    }
  })

  /**
   * GET /api/era/constitution
   * Get constitution file content for a project
   */
  app.get<{
    Querystring: { folder?: string }
  }>("/api/era/constitution", async (request) => {
    const { folder } = request.query

    logger.debug({ folder }, "Getting constitution")

    if (!folder) {
      return { success: false, error: "folder is required" }
    }

    const constitutionPath = `${folder}/.era/memory/constitution.md`

    try {
      const fs = await import("fs/promises")
      const content = await fs.readFile(constitutionPath, "utf-8")
      return {
        success: true,
        content,
        path: constitutionPath,
        exists: true,
        hash: Buffer.from(content).toString("base64").slice(0, 16),
      }
    } catch {
      return {
        success: true,
        content: "",
        path: constitutionPath,
        exists: false,
        hash: "",
      }
    }
  })
}

/**
 * Extract asset name from path
 * e.g., "/path/to/agent/plan.md" -> "plan"
 */
function extractAssetName(assetPath: string, type: string): string {
  const parts = assetPath.split("/")
  const filename = parts[parts.length - 1]
  return filename.replace(/\.(md|ts)$/, "")
}

/**
 * Extract skill name from directory path
 * e.g., "/path/to/skill/docs-generator" -> "docs-generator"
 */
function extractSkillName(skillPath: string): string {
  const parts = skillPath.split("/")
  return parts[parts.length - 1]
}
