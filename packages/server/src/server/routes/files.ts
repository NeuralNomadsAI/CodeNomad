/**
 * File Conflict Management API Routes
 *
 * Provides REST endpoints for tracking files, detecting conflicts,
 * and resolving merge conflicts between sessions.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import * as path from "path"
import * as fs from "fs"
import {
  ConflictDetector,
  FileConflict,
  getConflictDetector,
  createConflictDetector,
} from "../../filesystem/conflict-detector.js"
import { FileChangeTracker, getFileChangeTracker } from "../../filesystem/file-change-tracker.js"
import { MergeService, getMergeService } from "../../filesystem/merge-service.js"
import { EventBus } from "../../events/bus.js"
import { Logger } from "../../logger.js"

interface FileRouteDeps {
  eventBus: EventBus
  workspaceRoot?: string
  logger: Logger
}

interface TrackedFileInfo {
  path: string
  hash: string
  isBinary: boolean
  size: number
  sessions: Array<{
    sessionId: string
    mode: "read" | "write"
  }>
  hasConflict: boolean
  lastModified: number
}

interface ConflictInfo {
  conflictId: string
  filePath: string
  absolutePath: string
  conflictType: string
  involvedSessions: Array<{
    sessionId: string
    instanceId: string
    hash: string
    timestamp: number
  }>
  mergeResult: {
    canAutoMerge: boolean
    mergedContent?: string
    conflicts?: Array<{
      startLine: number
      endLine: number
      base: string
      ours: string
      theirs: string
    }>
  }
  timestamp: number
  isBinary: boolean
}

interface ConflictDetailResponse extends ConflictInfo {
  diff: {
    base: string
    ours: string
    theirs: string
    merged?: string
  }
}

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps) {
  const log = deps.logger.child({ component: "file-routes" })

  // Middleware to get or create conflict detector
  const getDetector = (workspaceRoot: string): ConflictDetector => {
    let detector = getConflictDetector(workspaceRoot)
    if (!detector) {
      detector = createConflictDetector({
        workspaceRoot,
        eventBus: deps.eventBus,
        logger: log,
        autoStart: true,
      })
    }
    return detector
  }

  /**
   * GET /api/files/tracked
   * List all tracked files with session info
   */
  app.get<{
    Querystring: { workspaceRoot?: string }
  }>("/api/files/tracked", async (request, reply) => {
    const workspaceRoot = request.query.workspaceRoot ?? deps.workspaceRoot
    if (!workspaceRoot) {
      return reply.code(400).send({ error: "workspaceRoot is required" })
    }

    const detector = getDetector(workspaceRoot)
    const tracker = detector.getTracker()
    const trackedFiles = tracker.getAllTrackedFiles()
    const conflicts = detector.getActiveConflicts()
    const conflictPaths = new Set(conflicts.map((c) => c.absolutePath))

    const files: TrackedFileInfo[] = trackedFiles.map((file) => {
      const sessions: Array<{ sessionId: string; mode: "read" | "write" }> = []

      for (const reader of file.readers) {
        if (!sessions.find((s) => s.sessionId === reader)) {
          sessions.push({
            sessionId: reader,
            mode: file.writers.has(reader) ? "write" : "read",
          })
        }
      }

      for (const writer of file.writers) {
        if (!sessions.find((s) => s.sessionId === writer)) {
          sessions.push({ sessionId: writer, mode: "write" })
        }
      }

      return {
        path: file.path,
        hash: file.currentHash,
        isBinary: file.isBinary,
        size: file.size,
        sessions,
        hasConflict: conflictPaths.has(file.absolutePath),
        lastModified: file.lastModified,
      }
    })

    return reply.send({ files })
  })

  /**
   * GET /api/files/conflicts
   * List active conflicts
   */
  app.get<{
    Querystring: { workspaceRoot?: string }
  }>("/api/files/conflicts", async (request, reply) => {
    const workspaceRoot = request.query.workspaceRoot ?? deps.workspaceRoot
    if (!workspaceRoot) {
      return reply.code(400).send({ error: "workspaceRoot is required" })
    }

    const detector = getDetector(workspaceRoot)
    const conflicts = detector.getActiveConflicts()

    const response: ConflictInfo[] = conflicts.map((c) => ({
      conflictId: c.conflictId,
      filePath: c.filePath,
      absolutePath: c.absolutePath,
      conflictType: c.conflictType,
      involvedSessions: c.involvedSessions,
      mergeResult: c.mergeResult,
      timestamp: c.timestamp,
      isBinary: c.isBinary,
    }))

    return reply.send({ conflicts: response })
  })

  /**
   * GET /api/files/conflicts/:id
   * Get conflict details with diff
   */
  app.get<{
    Params: { id: string }
    Querystring: { workspaceRoot?: string }
  }>("/api/files/conflicts/:id", async (request, reply) => {
    const { id } = request.params
    const workspaceRoot = request.query.workspaceRoot ?? deps.workspaceRoot
    if (!workspaceRoot) {
      return reply.code(400).send({ error: "workspaceRoot is required" })
    }

    const detector = getDetector(workspaceRoot)
    const conflict = detector.getConflict(id)

    if (!conflict) {
      return reply.code(404).send({ error: "Conflict not found" })
    }

    const tracker = detector.getTracker()
    const history = tracker.getFileHistory(conflict.absolutePath)

    // Get content for each version
    let baseContent = ""
    let oursContent = ""
    let theirsContent = ""

    // Base: earliest version
    if (history.length > 0 && history[0].content) {
      baseContent = history[0].content
    }

    // Ours: first non-external session's version
    const oursSession = conflict.involvedSessions.find((s) => s.sessionId !== "external")
    if (oursSession) {
      const oursVersion = history.find(
        (v) => v.sessionId === oursSession.sessionId && v.hash === oursSession.hash
      )
      if (oursVersion?.content) {
        oursContent = oursVersion.content
      }
    }

    // Theirs: current file content
    try {
      theirsContent = await fs.promises.readFile(conflict.absolutePath, "utf8")
    } catch {
      theirsContent = ""
    }

    const response: ConflictDetailResponse = {
      conflictId: conflict.conflictId,
      filePath: conflict.filePath,
      absolutePath: conflict.absolutePath,
      conflictType: conflict.conflictType,
      involvedSessions: conflict.involvedSessions,
      mergeResult: conflict.mergeResult,
      timestamp: conflict.timestamp,
      isBinary: conflict.isBinary,
      diff: {
        base: baseContent,
        ours: oursContent,
        theirs: theirsContent,
        merged: conflict.mergeResult.mergedContent,
      },
    }

    return reply.send({ conflict: response })
  })

  /**
   * POST /api/files/conflicts/:id/resolve
   * Resolve a conflict
   */
  app.post<{
    Params: { id: string }
    Body: {
      resolution: "auto-merged" | "keep-ours" | "keep-theirs" | "manual"
      content?: string
      sessionId: string
      workspaceRoot?: string
    }
  }>("/api/files/conflicts/:id/resolve", async (request, reply) => {
    const { id } = request.params
    const { resolution, content, sessionId, workspaceRoot: bodyWorkspaceRoot } = request.body
    const workspaceRoot = bodyWorkspaceRoot ?? deps.workspaceRoot

    if (!workspaceRoot) {
      return reply.code(400).send({ error: "workspaceRoot is required" })
    }

    if (!resolution) {
      return reply.code(400).send({ error: "resolution is required" })
    }

    if (!sessionId) {
      return reply.code(400).send({ error: "sessionId is required" })
    }

    if (resolution === "manual" && !content) {
      return reply.code(400).send({ error: "content is required for manual resolution" })
    }

    const detector = getDetector(workspaceRoot)
    const result = await detector.resolveConflict(id, resolution, sessionId, content)

    if (!result.success) {
      return reply.code(400).send({ error: result.error })
    }

    return reply.send({
      success: true,
      newHash: result.newHash,
    })
  })

  /**
   * POST /api/files/register
   * Register that a session is working with a file
   */
  app.post<{
    Body: {
      path: string
      sessionId: string
      instanceId: string
      mode: "read" | "write"
      content?: string
      hash?: string
      workspaceRoot?: string
    }
  }>("/api/files/register", async (request, reply) => {
    const {
      path: filePath,
      sessionId,
      instanceId,
      mode,
      content,
      hash,
      workspaceRoot: bodyWorkspaceRoot,
    } = request.body
    const workspaceRoot = bodyWorkspaceRoot ?? deps.workspaceRoot

    if (!workspaceRoot) {
      return reply.code(400).send({ error: "workspaceRoot is required" })
    }

    if (!filePath) {
      return reply.code(400).send({ error: "path is required" })
    }

    if (!sessionId) {
      return reply.code(400).send({ error: "sessionId is required" })
    }

    if (!instanceId) {
      return reply.code(400).send({ error: "instanceId is required" })
    }

    if (!mode || !["read", "write"].includes(mode)) {
      return reply.code(400).send({ error: "mode must be 'read' or 'write'" })
    }

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspaceRoot, filePath)

    const detector = getDetector(workspaceRoot)

    try {
      if (mode === "read") {
        const result = await detector.registerRead(absolutePath, sessionId, instanceId)
        return reply.send({
          success: true,
          hash: result.hash,
        })
      } else {
        // Write mode
        if (!content) {
          return reply.code(400).send({ error: "content is required for write mode" })
        }

        const result = await detector.registerWrite(
          absolutePath,
          sessionId,
          instanceId,
          content,
          hash
        )

        if (!result.success && result.conflict) {
          return reply.code(409).send({
            success: false,
            conflict: {
              conflictId: result.conflict.conflictId,
              filePath: result.conflict.filePath,
              conflictType: result.conflict.conflictType,
              canAutoMerge: result.conflict.mergeResult.canAutoMerge,
            },
          })
        }

        return reply.send({
          success: true,
          hash: result.hash,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      log.error({ error, filePath, sessionId, mode }, "Failed to register file")
      return reply.code(500).send({ error: message })
    }
  })

  /**
   * POST /api/files/unregister-session
   * Unregister a session from file tracking
   */
  app.post<{
    Body: {
      sessionId: string
      workspaceRoot?: string
    }
  }>("/api/files/unregister-session", async (request, reply) => {
    const { sessionId, workspaceRoot: bodyWorkspaceRoot } = request.body
    const workspaceRoot = bodyWorkspaceRoot ?? deps.workspaceRoot

    if (!workspaceRoot) {
      return reply.code(400).send({ error: "workspaceRoot is required" })
    }

    if (!sessionId) {
      return reply.code(400).send({ error: "sessionId is required" })
    }

    const detector = getDetector(workspaceRoot)
    detector.unregisterSession(sessionId)

    return reply.send({ success: true })
  })

  /**
   * GET /api/files/history
   * Get version history for a file
   */
  app.get<{
    Querystring: {
      path: string
      workspaceRoot?: string
    }
  }>("/api/files/history", async (request, reply) => {
    const { path: filePath, workspaceRoot: queryWorkspaceRoot } = request.query
    const workspaceRoot = queryWorkspaceRoot ?? deps.workspaceRoot

    if (!workspaceRoot) {
      return reply.code(400).send({ error: "workspaceRoot is required" })
    }

    if (!filePath) {
      return reply.code(400).send({ error: "path is required" })
    }

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspaceRoot, filePath)

    const detector = getDetector(workspaceRoot)
    const tracker = detector.getTracker()
    const history = tracker.getFileHistory(absolutePath)

    const versions = history.map((v) => ({
      hash: v.hash,
      timestamp: v.timestamp,
      sessionId: v.sessionId,
      instanceId: v.instanceId,
      hasContent: !!v.content,
    }))

    return reply.send({ versions })
  })

  /**
   * POST /api/files/merge-preview
   * Preview a 3-way merge without applying it
   */
  app.post<{
    Body: {
      base: string
      ours: string
      theirs: string
      filePath?: string
    }
  }>("/api/files/merge-preview", async (request, reply) => {
    const { base, ours, theirs, filePath } = request.body

    if (base === undefined || ours === undefined || theirs === undefined) {
      return reply.code(400).send({ error: "base, ours, and theirs are required" })
    }

    try {
      const merger = getMergeService()
      const result = merger.merge({
        filePath: filePath ?? "unknown",
        base,
        ours,
        theirs,
      })

      return reply.send({
        success: result.success,
        merged: result.merged,
        hasConflicts: result.hasConflicts,
        conflicts: result.conflicts,
        stats: result.stats,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      const stack = error instanceof Error ? error.stack : undefined
      log.error({ error, message, stack, base, ours, theirs, filePath }, "Merge preview failed")
      return reply.code(500).send({ error: message, stack })
    }
  })

  /**
   * GET /api/files/stats
   * Get file tracking statistics
   */
  app.get<{
    Querystring: { workspaceRoot?: string }
  }>("/api/files/stats", async (request, reply) => {
    const workspaceRoot = request.query.workspaceRoot ?? deps.workspaceRoot
    if (!workspaceRoot) {
      return reply.code(400).send({ error: "workspaceRoot is required" })
    }

    const detector = getDetector(workspaceRoot)
    const tracker = detector.getTracker()
    const conflicts = detector.getActiveConflicts()
    const stats = tracker.getStats()

    return reply.send({
      trackedFiles: stats.trackedFiles,
      totalVersions: stats.totalVersions,
      activeSessions: stats.activeSessions,
      activeConflicts: conflicts.length,
      watcherRunning: detector.getWatcher().running(),
    })
  })

  /**
   * POST /api/files/reset
   * Reset all file tracking state (for testing)
   */
  app.post<{
    Body: {
      workspaceRoot?: string
    }
  }>("/api/files/reset", async (request, reply) => {
    const { workspaceRoot: bodyWorkspaceRoot } = request.body ?? {}
    const workspaceRoot = bodyWorkspaceRoot ?? deps.workspaceRoot

    if (!workspaceRoot) {
      return reply.code(400).send({ error: "workspaceRoot is required" })
    }

    const detector = getDetector(workspaceRoot)
    detector.clear()

    log.info({ workspaceRoot }, "File tracking state reset")

    return reply.send({ success: true })
  })
}
