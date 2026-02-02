import { FastifyInstance } from "fastify"
import type { EraStatusResponse, UpdateCheckResult } from "../../api-types"
import type { EraDetectionService } from "../../era/detection"
import type { EraGovernanceService } from "../../era/governance"
import type { UpdateMonitor } from "../../updates/update-monitor"
import type { Logger } from "../../logger"
import {
  GovernanceWriter,
  type WriteInstructionRequest,
  type WriteInstructionResponse,
  type DeleteInstructionRequest,
  type EditInstructionRequest,
  type PromoteRequest,
  type ListInstructionsRequest,
} from "../../services/governance-writer"
import { LlmClassifier } from "../../services/llm-classifier"
import {
  InstructionRetrieval,
  InstructionPruner,
  composeRetrievedSection,
  recordFeedback,
  type RetrievalContext,
  type RetrievedInstruction,
  type FeedbackEvent,
  type DedupOverlap,
} from "../../services/instruction-retrieval"
import { EraMemoryClient } from "../../services/era-memory-client"

interface RouteDeps {
  eraDetection: EraDetectionService
  eraGovernance: EraGovernanceService
  updateMonitor?: UpdateMonitor
  logger: Logger
}

export function registerEraRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { eraDetection, eraGovernance, updateMonitor, logger } = deps

  function validateFolder(folder: string | undefined): string | undefined {
    if (!folder) return undefined
    if (folder.includes("..") || folder.includes("\0")) {
      logger.warn({ folder }, "Rejected suspicious folder path")
      return undefined
    }
    return folder
  }

  /**
   * GET /api/era/status
   * Returns the era-code installation status and project initialization state
   */
  app.get<{
    Querystring: { folder?: string }
  }>("/api/era/status", async (request) => {
    const folder = validateFolder(request.query.folder)

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
      agents: assets.agents.map((p) => extractAssetName(p)),
      commands: assets.commands.map((p) => extractAssetName(p)),
      skills: assets.skills.map((p) => extractSkillName(p)),
      plugins: assets.plugins.map((p) => extractAssetName(p)),
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
    const folder = validateFolder(request.query.folder)
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
    const folder = validateFolder(request.query.folder)
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
    const folder = validateFolder(request.query.folder)
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

  // --------------------------------------------------------------------------
  // Instruction Capture & Governance Memory
  // --------------------------------------------------------------------------

  const eraMemoryClient = new EraMemoryClient()

  app.addHook("onClose", async () => {
    if (typeof (eraMemoryClient as any).close === "function") await (eraMemoryClient as any).close()
  })

  const governanceWriter = new GovernanceWriter()
  const llmClassifier = new LlmClassifier()
  const instructionRetrieval = new InstructionRetrieval(eraMemoryClient)
  const instructionPruner = new InstructionPruner(eraMemoryClient)

  /**
   * POST /api/era/classify-confirm
   * Use Haiku to refine a borderline instruction classification.
   * Returns { unavailable: true } if the API key is missing or the call fails.
   */
  app.post<{
    Body: { message: string }
  }>("/api/era/classify-confirm", async (request, reply) => {
    const { message } = request.body ?? {}

    if (!message || typeof message !== "string") {
      reply.code(400)
      return { error: "message is required" }
    }

    if (!llmClassifier.isAvailable()) {
      return { unavailable: true }
    }

    try {
      const result = await llmClassifier.classify(message)
      if (!result) {
        return { unavailable: true }
      }
      return result
    } catch {
      return { unavailable: true }
    }
  })

  /**
   * POST /api/era/classify-instruction
   * Persist a classified instruction to the appropriate storage layer.
   */
  app.post<{
    Body: WriteInstructionRequest
  }>("/api/era/classify-instruction", async (request, reply) => {
    const body = request.body
    if (!body || !body.instruction || !body.category) {
      return reply.status(400).send({ error: "Missing required fields: instruction, category" })
    }

    try {
      const result: WriteInstructionResponse = await governanceWriter.writeInstruction(body)
      return result
    } catch (err) {
      logger.error({ err }, "Failed to persist instruction")
      return reply.status(500).send({
        error: "write_failure",
        message: err instanceof Error ? err.message : "Failed to persist instruction",
      })
    }
  })

  /**
   * GET /api/era/directives/history
   * Returns the change history for directives.
   */
  app.get<{
    Querystring: { folder?: string }
  }>("/api/era/directives/history", async (request) => {
    const folder = validateFolder(request.query.folder)
    const historyPath = folder
      ? `${folder}/.era/memory/directives-history.json`
      : `${process.env.HOME ?? "."}/.era/memory/directives-history.json`

    try {
      const fs = await import("node:fs/promises")
      const raw = await fs.readFile(historyPath, "utf-8")
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed
    } catch {
      return []
    }
  })

  /**
   * GET /api/era/instructions
   * List all saved instructions (directives + memories).
   */
  app.get<{
    Querystring: { scope?: "project" | "global"; folder?: string }
  }>("/api/era/instructions", async (request) => {
    const { scope, folder } = request.query

    try {
      const instructions = await governanceWriter.listInstructions({
        scope,
        projectPath: folder,
      })
      return { success: true, instructions }
    } catch (err) {
      logger.error({ err }, "Failed to list instructions")
      return { success: false, instructions: [], error: err instanceof Error ? err.message : "Unknown error" }
    }
  })

  /**
   * DELETE /api/era/instructions
   * Delete a saved instruction.
   */
  app.delete<{
    Body: DeleteInstructionRequest
  }>("/api/era/instructions", async (request, reply) => {
    const body = request.body
    if (!body || !body.id || !body.storageType) {
      return reply.status(400).send({ success: false, error: "Missing required fields: id, storageType" })
    }

    try {
      const result = await governanceWriter.deleteInstruction(body)
      return result
    } catch (err) {
      logger.error({ err }, "Failed to delete instruction")
      return reply.status(500).send({ success: false, error: err instanceof Error ? err.message : "Unknown error" })
    }
  })

  /**
   * PATCH /api/era/instructions
   * Edit an existing instruction.
   */
  app.patch<{
    Body: EditInstructionRequest
  }>("/api/era/instructions", async (request, reply) => {
    const body = request.body
    if (!body || !body.id || !body.storageType || !body.newContent) {
      return reply.status(400).send({ success: false, error: "Missing required fields: id, storageType, newContent" })
    }

    try {
      const result = await governanceWriter.editInstruction(body)
      return result
    } catch (err) {
      logger.error({ err }, "Failed to edit instruction")
      return reply.status(500).send({ success: false, error: err instanceof Error ? err.message : "Unknown error" })
    }
  })

  /**
   * POST /api/era/instructions/promote
   * Promote a memory instruction to a directive.
   */
  app.post<{
    Body: PromoteRequest
  }>("/api/era/instructions/promote", async (request, reply) => {
    const body = request.body
    if (!body || !body.id || !body.content || !body.category) {
      return reply.status(400).send({ error: "Missing required fields: id, content, category" })
    }

    try {
      const result = await governanceWriter.promoteInstruction(body)
      return result
    } catch (err) {
      logger.error({ err }, "Failed to promote instruction")
      return reply.status(500).send({ error: err instanceof Error ? err.message : "Unknown error" })
    }
  })

  /**
   * POST /api/era/instructions/demote
   * Demote a directive to a memory instruction.
   */
  app.post<{
    Body: PromoteRequest
  }>("/api/era/instructions/demote", async (request, reply) => {
    const body = request.body
    if (!body || !body.id || !body.content || !body.category) {
      return reply.status(400).send({ error: "Missing required fields: id, content, category" })
    }

    try {
      const result = await governanceWriter.demoteInstruction(body)
      return result
    } catch (err) {
      logger.error({ err }, "Failed to demote instruction")
      return reply.status(500).send({ error: err instanceof Error ? err.message : "Unknown error" })
    }
  })

  // ============================================================================
  // INSTRUCTION RETRIEVAL ROUTES
  // ============================================================================

  /**
   * POST /api/era/retrieval/session-start
   * Retrieve instructions relevant to a new session.
   */
  app.post<{
    Body: { sessionId: string; context?: RetrievalContext }
  }>("/api/era/retrieval/session-start", async (request) => {
    const { sessionId, context } = request.body ?? {}

    if (!sessionId) {
      return { instructions: [] as RetrievedInstruction[], composed: "" }
    }

    try {
      const instructions = await instructionRetrieval.retrieveAtSessionStart(sessionId, context ?? {})
      const composed = composeRetrievedSection(instructions)
      return { instructions, composed }
    } catch (err) {
      logger.error({ err }, "Failed to retrieve session-start instructions")
      return { instructions: [] as RetrievedInstruction[], composed: "" }
    }
  })

  /**
   * POST /api/era/retrieval/tool
   * Retrieve instructions relevant to a specific tool invocation.
   */
  app.post<{
    Body: { sessionId: string; toolName: string; context?: RetrievalContext }
  }>("/api/era/retrieval/tool", async (request) => {
    const { sessionId, toolName, context } = request.body ?? {}

    if (!sessionId || !toolName) {
      return { instructions: [] as RetrievedInstruction[], composed: "" }
    }

    try {
      const instructions = await instructionRetrieval.retrieveForTool(sessionId, toolName, context ?? {})
      const composed = composeRetrievedSection(instructions)
      return { instructions, composed }
    } catch (err) {
      logger.error({ err }, "Failed to retrieve tool instructions")
      return { instructions: [] as RetrievedInstruction[], composed: "" }
    }
  })

  /**
   * POST /api/era/retrieval/flush
   * Flush access counts to Era Memory at session end.
   */
  app.post<{
    Body: { sessionId: string }
  }>("/api/era/retrieval/flush", async (request) => {
    const { sessionId } = request.body ?? {}

    if (!sessionId) {
      return { flushed: false, count: 0, promotionCandidates: [] }
    }

    try {
      const result = await instructionRetrieval.flushAccessCounts(sessionId)
      return { flushed: true, count: result.flushed, promotionCandidates: result.promotionCandidates }
    } catch (err) {
      logger.error({ err }, "Failed to flush session access counts")
      return { flushed: false, count: 0, promotionCandidates: [] }
    }
  })

  /**
   * POST /api/era/retrieval/prune
   * Run instruction pruning engine.
   */
  app.post<{
    Body: { projectPath?: string }
  }>("/api/era/retrieval/prune", async (request) => {
    const { projectPath } = request.body ?? {}

    try {
      return await instructionPruner.prune(projectPath)
    } catch (err) {
      logger.error({ err }, "Failed to prune instructions")
      return { flaggedForReview: [], archived: [], errors: [err instanceof Error ? err.message : "Unknown error"] }
    }
  })

  /**
   * POST /api/era/retrieval/feedback
   * Record feedback for a retrieved instruction (success/failure/dismissed).
   */
  app.post<{
    Body: { sessionId: string; instructionId: string; outcome: "success" | "failure" | "dismissed" }
  }>("/api/era/retrieval/feedback", async (request, reply) => {
    const { sessionId, instructionId, outcome } = request.body ?? {}

    if (!sessionId || !instructionId || !outcome) {
      reply.code(400)
      return { error: "sessionId, instructionId, and outcome are required" }
    }

    if (!["success", "failure", "dismissed"].includes(outcome)) {
      reply.code(400)
      return { error: "outcome must be success, failure, or dismissed" }
    }

    try {
      const event: FeedbackEvent = { sessionId, instructionId, outcome }
      const result = await recordFeedback(eraMemoryClient, event)
      return result
    } catch (err) {
      logger.error({ err }, "Failed to record feedback")
      return { promoted: false, accessCount: 0, feedbackScore: 0 }
    }
  })

  /**
   * GET /api/era/retrieval/promotion-candidates
   * Query instructions that meet the promotion threshold.
   */
  app.get("/api/era/retrieval/promotion-candidates", async () => {
    try {
      const candidates = await instructionRetrieval.getPromotionCandidates()
      return { candidates }
    } catch (err) {
      logger.error({ err }, "Failed to get promotion candidates")
      return { candidates: [] }
    }
  })

  /**
   * GET /api/era/retrieval/overlaps
   * Get dedup overlaps for a session (debugging/testing).
   */
  app.get<{
    Querystring: { sessionId: string }
  }>("/api/era/retrieval/overlaps", async (request) => {
    const { sessionId } = request.query

    if (!sessionId) {
      return { overlaps: [] as DedupOverlap[] }
    }

    try {
      const overlaps = instructionRetrieval.getDedupOverlaps(sessionId)
      return { overlaps }
    } catch (err) {
      logger.error({ err }, "Failed to get dedup overlaps")
      return { overlaps: [] as DedupOverlap[] }
    }
  })

  // ============================================================================
  // PHASE 5: VISUALIZATION ROUTES
  // ============================================================================

  /**
   * GET /api/era/delegation/categories
   * Returns delegation category list with current model assignments.
   */
  app.get<{
    Querystring: { folder?: string }
  }>("/api/era/delegation/categories", async (request) => {
    logger.debug({ folder: request.query.folder }, "Getting delegation categories")

    return {
      categories: [
        { id: "visual-engineering", name: "Visual Engineering", model: "claude-sonnet-4", keywords: ["ui", "css", "layout", "component", "style"], active: true },
        { id: "ultrabrain", name: "Ultrabrain", model: "claude-opus-4", keywords: ["architect", "design", "plan", "complex", "system"], active: true },
        { id: "artistry", name: "Artistry", model: "claude-sonnet-4", keywords: ["create", "write", "compose", "generate", "craft"], active: true },
        { id: "quick", name: "Quick Tasks", model: "claude-haiku-4", keywords: ["fix", "typo", "rename", "simple", "small"], active: true },
        { id: "writing", name: "Writing", model: "claude-sonnet-4", keywords: ["document", "readme", "explain", "describe"], active: true },
        { id: "unspecified-low", name: "General (Low)", model: "claude-haiku-4", keywords: [], active: true },
        { id: "unspecified-high", name: "General (High)", model: "claude-sonnet-4", keywords: [], active: true },
      ],
    }
  })

  /**
   * GET /api/era/models/fallback-chain
   * Returns model resolution fallback chains per provider.
   */
  app.get("/api/era/models/fallback-chain", async () => {
    logger.debug("Getting model fallback chains")

    return {
      chains: [
        {
          provider: "anthropic",
          primary: { id: "claude-opus-4", name: "Claude Opus 4", available: true },
          fallbacks: [
            { id: "claude-sonnet-4", name: "Claude Sonnet 4", available: true },
            { id: "claude-haiku-4", name: "Claude Haiku 4", available: true },
          ],
        },
        {
          provider: "openai",
          primary: { id: "gpt-4o", name: "GPT-4o", available: true },
          fallbacks: [
            { id: "gpt-4o-mini", name: "GPT-4o Mini", available: true },
          ],
        },
        {
          provider: "google",
          primary: { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", available: true },
          fallbacks: [],
        },
      ],
    }
  })

  /**
   * GET /api/era/health
   * Returns system health status based on available detection info.
   */
  app.get<{
    Querystring: { folder?: string }
  }>("/api/era/health", async (request) => {
    const folder = validateFolder(request.query.folder)
    logger.debug({ folder }, "Running health check")

    try {
      const binary = eraDetection.detectBinary()
      const governanceOk = folder ? eraGovernance.getConfig(folder).success : false

      return {
        checks: [
          { name: "era-code", status: binary.installed ? "healthy" : "error", message: binary.installed ? `v${binary.version}` : "Not installed" },
          { name: "governance", status: governanceOk ? "healthy" : folder ? "warning" : "unknown", message: governanceOk ? "Config loaded" : folder ? "No governance config" : "No project folder" },
          { name: "beads", status: "unknown", message: "Beads integration pending" },
          { name: "mcp-servers", status: "healthy", message: "Available" },
        ],
        overall: binary.installed ? "healthy" : "error",
        timestamp: new Date().toISOString(),
      }
    } catch (err) {
      logger.error({ err }, "Health check failed")
      return {
        checks: [{ name: "era-code", status: "error", message: String(err) }],
        overall: "error",
        timestamp: new Date().toISOString(),
      }
    }
  })

  /**
   * GET /api/era/beads/issues
   * Returns beads issues for the project (empty until beads integration is wired).
   */
  app.get<{
    Querystring: { folder?: string; status?: string }
  }>("/api/era/beads/issues", async (request) => {
    logger.debug({ folder: request.query.folder }, "Getting beads issues")
    return { issues: [], total: 0 }
  })

  /**
   * GET /api/era/beads/graph
   * Returns beads dependency graph (empty until beads integration is wired).
   */
  app.get<{
    Querystring: { folder?: string }
  }>("/api/era/beads/graph", async (request) => {
    logger.debug({ folder: request.query.folder }, "Getting beads dependency graph")
    return { nodes: [], edges: [] }
  })

  /**
   * GET /api/era/audit/events
   * Returns audit trail events (empty until audit trail service is wired).
   */
  app.get<{
    Querystring: { folder?: string; actor?: string; type?: string; since?: string; limit?: string }
  }>("/api/era/audit/events", async (request) => {
    logger.debug({ folder: request.query.folder, actor: request.query.actor }, "Getting audit events")
    return { events: [], total: 0 }
  })

  /**
   * POST /api/era/refactoring/impact
   * Analyze refactoring impact (returns safe default until tugtool is wired).
   */
  app.post<{
    Body: { folder: string; operation: string; target: string }
  }>("/api/era/refactoring/impact", async (request, reply) => {
    const { folder, operation, target } = request.body ?? {}
    if (!folder || !operation || !target) {
      reply.code(400)
      return { error: "folder, operation, and target are required" }
    }

    logger.info({ folder, operation, target }, "Analyzing refactoring impact")
    return {
      operation,
      target,
      affectedFiles: [],
      references: 0,
      warnings: [],
      safe: true,
    }
  })

  /**
   * GET /api/era/verification/status
   * Returns current verification pipeline status.
   */
  app.get<{
    Querystring: { folder?: string }
  }>("/api/era/verification/status", async (request) => {
    logger.debug({ folder: request.query.folder }, "Getting verification status")

    return {
      phases: [
        { name: "analyze", status: "idle", duration: null },
        { name: "preview", status: "idle", duration: null },
        { name: "verify", status: "idle", duration: null },
        { name: "apply", status: "idle", duration: null },
      ],
      overall: "idle",
      lastRun: null,
    }
  })

  /**
   * GET /api/era/governance/file-rules
   * Returns governance rules applicable to specific file paths.
   */
  app.get<{
    Querystring: { folder?: string; path?: string }
  }>("/api/era/governance/file-rules", async (request) => {
    const { folder, path: filePath } = request.query
    logger.debug({ folder, filePath }, "Getting file governance rules")

    try {
      const config = eraGovernance.getConfig(folder)
      if (!config.success) {
        return { rules: [], scopeActive: false }
      }

      const rules = config.config.rules.flatMap((category) =>
        category.rules.map((rule) => ({
          id: rule.id,
          categoryId: category.categoryId,
          categoryName: category.categoryName,
          action: rule.action,
          source: rule.source,
        }))
      )

      return { rules, scopeActive: true }
    } catch (err) {
      logger.error({ err }, "Failed to get file governance rules")
      return { rules: [], scopeActive: false }
    }
  })

  // =========================================================================
  // Phase 7: Workflow Formulas & Plan Execution
  // =========================================================================

  /** GET /api/era/formulas — List available workflow formulas */
  app.get<{
    Querystring: { folder?: string }
  }>("/api/era/formulas", async (request) => {
    try {
      // Return sample formulas for UI development; real formulas come from era-code
      return {
        formulas: [
          {
            name: "deploy-service",
            description: "Build, test, and deploy a service to production with approval gate",
            source: "built-in",
            variables: [
              { name: "service_name", type: "string", required: true, description: "Service to deploy" },
              { name: "version", type: "string", default: "latest", description: "Version tag" },
              { name: "replicas", type: "number", default: 3, description: "Number of replicas" },
            ],
            steps: [
              { id: "build", name: "Build", action: "build" },
              { id: "test", name: "Test", action: "test", dependsOn: ["build"] },
              { id: "approve", name: "Approval gate", action: "gate", dependsOn: ["test"], gate: "human" },
              { id: "deploy", name: "Deploy", action: "deploy", dependsOn: ["approve"] },
              { id: "verify", name: "Verify", action: "verify", dependsOn: ["deploy"] },
            ],
            tags: ["deploy", "production"],
            parallelism: 1,
          },
          {
            name: "full-test-suite",
            description: "Run unit, integration, and e2e tests with coverage reporting",
            source: "project",
            variables: [
              { name: "test_pattern", type: "string", default: "**/*.test.ts", description: "Test glob pattern" },
              { name: "coverage", type: "boolean", default: true, description: "Enable coverage" },
            ],
            steps: [
              { id: "unit", name: "Unit tests", action: "test" },
              { id: "integration", name: "Integration tests", action: "test" },
              { id: "e2e", name: "E2E tests", action: "test" },
              { id: "report", name: "Coverage report", action: "report", dependsOn: ["unit", "integration", "e2e"] },
            ],
            tags: ["test", "ci"],
            parallelism: 3,
          },
        ],
      }
    } catch (err) {
      logger.error({ err }, "Failed to fetch formulas")
      return { formulas: [] }
    }
  })

  /** GET /api/era/plans/status — Get plan execution status */
  app.get<{
    Querystring: { planId?: string; folder?: string }
  }>("/api/era/plans/status", async (request) => {
    try {
      const { planId } = request.query
      if (!planId) return { plan: null }

      // Return placeholder plan status; real plans come from era-code runtime
      return {
        plan: {
          id: planId,
          formulaName: "deploy-service",
          status: "pending",
          steps: [
            { id: "p1", stepId: "build", name: "Build", action: "build", status: "pending", dependsOn: [] },
            { id: "p2", stepId: "test", name: "Test", action: "test", status: "pending", dependsOn: ["build"] },
            { id: "p3", stepId: "approve", name: "Approval gate", action: "gate", status: "pending", dependsOn: ["test"], gateType: "human" },
            { id: "p4", stepId: "deploy", name: "Deploy", action: "deploy", status: "pending", dependsOn: ["approve"] },
          ],
          checkpoints: [],
          details: [],
          createdAt: new Date().toISOString(),
        },
      }
    } catch (err) {
      logger.error({ err }, "Failed to fetch plan status")
      return { plan: null }
    }
  })

  // =========================================================================
  // Phase 8: Agent Lifecycle, Gates, Swarm, Handoffs
  // =========================================================================

  /** GET /api/era/agents/queue — Agent queue status */
  app.get("/api/era/agents/queue", async () => {
    try {
      return { agents: [] }
    } catch (err) {
      logger.error({ err }, "Failed to fetch agent queue")
      return { agents: [] }
    }
  })

  /** GET /api/era/agents/lifecycle — Agent lifecycle states */
  app.get("/api/era/agents/lifecycle", async () => {
    try {
      return { agents: [] }
    } catch (err) {
      logger.error({ err }, "Failed to fetch agent lifecycle")
      return { agents: [] }
    }
  })

  /** GET /api/era/swarm/messages — Swarm communication messages */
  app.get("/api/era/swarm/messages", async () => {
    try {
      return { messages: [] }
    } catch (err) {
      logger.error({ err }, "Failed to fetch swarm messages")
      return { messages: [] }
    }
  })

  /** GET /api/era/gates/status — Gate statuses */
  app.get<{
    Querystring: { planId?: string }
  }>("/api/era/gates/status", async (request) => {
    const _planId = request.query.planId
    try {
      return { gates: [] }
    } catch (err) {
      logger.error({ err }, "Failed to fetch gates")
      return { gates: [] }
    }
  })

  /** GET /api/era/handoffs — Session handoffs */
  app.get<{
    Querystring: { sessionId?: string }
  }>("/api/era/handoffs", async (request) => {
    const _sessionId = request.query.sessionId
    try {
      return { handoffs: [], chain: [] }
    } catch (err) {
      logger.error({ err }, "Failed to fetch handoffs")
      return { handoffs: [], chain: [] }
    }
  })
}

/**
 * Extract asset name from path
 * e.g., "/path/to/agent/plan.md" -> "plan"
 */
function extractAssetName(assetPath: string): string {
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
