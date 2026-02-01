import { FastifyInstance } from "fastify"
import fs from "fs/promises"
import path from "path"
import os from "os"

interface RouteLogger {
  info: (obj: Record<string, unknown>, msg: string) => void
  debug: (obj: Record<string, unknown>, msg: string) => void
  error: (obj: Record<string, unknown>, msg: string) => void
}

interface SessionFile {
  id: string
  projectID: string
  directory: string
  title: string
  time: { created: number; updated: number }
  summary?: { additions: number; deletions: number; files: number }
}

export interface ManagedSession {
  id: string
  projectId: string
  directory: string
  title: string
  createdAt: number
  updatedAt: number
  summary: { additions: number; deletions: number; files: number }
}

export interface ManagedProject {
  id: string
  directory: string
  sessionCount: number
}

export interface SessionsListResponse {
  sessions: ManagedSession[]
  projects: ManagedProject[]
}

export interface SessionDeleteResponse {
  success: boolean
  deleted: number
  errors?: string[]
}

export interface SessionStatsResponse {
  total: number
  projectCount: number
  staleCount: number
  blankCount: number
}

const OPENCODE_STORAGE_PATH = path.join(
  os.homedir(),
  ".local/share/opencode/storage/session"
)

interface RouteDeps {
  logger: RouteLogger
}

export function registerSessionRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { logger } = deps

  // GET /api/sessions - List all sessions across all projects
  app.get("/api/sessions", async (): Promise<SessionsListResponse> => {
    const sessions = await readAllSessionFiles(logger)
    const projectMap = new Map<string, { directory: string; count: number }>()

    for (const session of sessions) {
      if (!projectMap.has(session.projectID)) {
        projectMap.set(session.projectID, { directory: session.directory, count: 0 })
      }
      const projectInfo = projectMap.get(session.projectID)!
      projectInfo.count++
    }

    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        projectId: s.projectID,
        directory: s.directory,
        title: s.title,
        createdAt: s.time.created,
        updatedAt: s.time.updated,
        summary: s.summary || { additions: 0, deletions: 0, files: 0 },
      })),
      projects: Array.from(projectMap.entries()).map(([id, info]) => ({
        id,
        directory: info.directory,
        sessionCount: info.count,
      })),
    }
  })

  // DELETE /api/sessions - Bulk delete sessions
  app.delete<{ Body: { sessionIds: string[] } }>("/api/sessions", async (request): Promise<SessionDeleteResponse> => {
    const { sessionIds } = request.body ?? { sessionIds: [] }
    let deleted = 0
    const errors: string[] = []

    for (const sessionId of sessionIds) {
      try {
        await deleteSession(sessionId, logger)
        deleted++
      } catch (error) {
        const errorMsg = `Failed to delete ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
        errors.push(errorMsg)
        logger.debug({ sessionId, error }, "Failed to delete session")
      }
    }

    return {
      success: errors.length === 0,
      deleted,
      errors: errors.length > 0 ? errors : undefined,
    }
  })

  // DELETE /api/sessions/:id - Delete a single session
  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request): Promise<{ success: boolean; error?: string }> => {
    try {
      await deleteSession(request.params.id, logger)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  // GET /api/sessions/stats - Lightweight session stats for activity monitor
  app.get("/api/sessions/stats", async (): Promise<SessionStatsResponse> => {
    const sessions = await readAllSessionFiles(logger)
    const now = Date.now()
    const STALE_THRESHOLD = 7 * 24 * 60 * 60 * 1000 // 7 days

    const projectDirs = new Set<string>()
    let staleCount = 0
    let blankCount = 0

    for (const session of sessions) {
      projectDirs.add(session.projectID)
      if (session.time.updated < now - STALE_THRESHOLD) {
        staleCount++
      }
      const summary = session.summary || { additions: 0, deletions: 0, files: 0 }
      if (summary.files === 0 && summary.additions === 0) {
        blankCount++
      }
    }

    return {
      total: sessions.length,
      projectCount: projectDirs.size,
      staleCount,
      blankCount,
    }
  })

  // DELETE /api/sessions/stale - Purge sessions not updated in 7+ days
  app.delete("/api/sessions/stale", async (): Promise<SessionDeleteResponse> => {
    const sessions = await readAllSessionFiles(logger)
    const now = Date.now()
    const STALE_THRESHOLD = 7 * 24 * 60 * 60 * 1000

    const staleIds = sessions
      .filter((s) => s.time.updated < now - STALE_THRESHOLD)
      .map((s) => s.id)

    let deleted = 0
    const errors: string[] = []

    for (const sessionId of staleIds) {
      try {
        await deleteSession(sessionId, logger)
        deleted++
      } catch (error) {
        errors.push(`Failed to delete ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    logger.info({ deleted, errors: errors.length }, "Purged stale sessions")
    return {
      success: errors.length === 0,
      deleted,
      errors: errors.length > 0 ? errors : undefined,
    }
  })

  // DELETE /api/sessions/blank - Clean sessions with no file changes
  app.delete("/api/sessions/blank", async (): Promise<SessionDeleteResponse> => {
    const sessions = await readAllSessionFiles(logger)

    const blankIds = sessions
      .filter((s) => {
        const summary = s.summary || { additions: 0, deletions: 0, files: 0 }
        return summary.files === 0 && summary.additions === 0
      })
      .map((s) => s.id)

    let deleted = 0
    const errors: string[] = []

    for (const sessionId of blankIds) {
      try {
        await deleteSession(sessionId, logger)
        deleted++
      } catch (error) {
        errors.push(`Failed to delete ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    logger.info({ deleted, errors: errors.length }, "Cleaned blank sessions")
    return {
      success: errors.length === 0,
      deleted,
      errors: errors.length > 0 ? errors : undefined,
    }
  })
}

async function readAllSessionFiles(logger: RouteLogger): Promise<SessionFile[]> {
  const sessions: SessionFile[] = []

  try {
    await fs.access(OPENCODE_STORAGE_PATH)
  } catch {
    return sessions
  }

  try {
    const projectDirs = await fs.readdir(OPENCODE_STORAGE_PATH)

    for (const projectHash of projectDirs) {
      const projectPath = path.join(OPENCODE_STORAGE_PATH, projectHash)

      try {
        const stat = await fs.stat(projectPath)
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }

      const sessionFiles = await fs.readdir(projectPath)
      for (const sessionFile of sessionFiles) {
        if (!sessionFile.endsWith(".json")) continue

        try {
          const sessionPath = path.join(projectPath, sessionFile)
          const content = await fs.readFile(sessionPath, "utf-8")
          const session: SessionFile = JSON.parse(content)
          sessions.push(session)
        } catch (error) {
          logger.debug({ file: sessionFile, error }, "Skipping malformed session file")
        }
      }
    }
  } catch (error) {
    logger.error({ error }, "Error reading sessions")
  }

  return sessions
}

async function deleteSession(sessionId: string, logger: RouteLogger): Promise<void> {
  try {
    await fs.access(OPENCODE_STORAGE_PATH)
  } catch {
    throw new Error(`Session storage not found`)
  }

  const projectDirs = await fs.readdir(OPENCODE_STORAGE_PATH)

  for (const projectHash of projectDirs) {
    const sessionPath = path.join(OPENCODE_STORAGE_PATH, projectHash, `${sessionId}.json`)
    try {
      await fs.access(sessionPath)
      await fs.unlink(sessionPath)
      logger.info({ sessionId, path: sessionPath }, "Deleted session")
      return
    } catch {
      // File doesn't exist in this project, continue searching
    }
  }

  throw new Error(`Session ${sessionId} not found`)
}
