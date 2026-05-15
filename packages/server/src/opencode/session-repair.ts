import { backup, DatabaseSync } from "node:sqlite"
import { spawnSync } from "child_process"
import { promises as fsp } from "fs"
import os from "os"
import path from "path"

import type {
  OpenCodeSessionRepairAnalysis,
  OpenCodeSessionRepairIssueSession,
  OpenCodeSessionRepairMode,
  OpenCodeSessionRepairResult,
} from "../api-types"
import type { Logger } from "../logger"
import type { BinaryResolver } from "../settings/binaries"
import type { SettingsService } from "../settings/service"
import { buildSpawnSpec } from "../workspaces/spawn"
import type { WorkspaceManager } from "../workspaces/manager"

type SessionRow = {
  id: string
  projectId: string
  title: string
  directory: string | null
  version: string
  agent: string | null
  model: string | null
  path: string | null
}

type DerivedSessionMetadata = {
  agent?: string
  model?: string
}

type SessionRepairState = {
  dbPath: string
  assistantMessageCount: number
  sessions: SessionRow[]
  missingAssistantAgentMessages: Map<string, number>
  derivedMetadataBySession: Map<string, DerivedSessionMetadata>
  recommendedDirectoryBySession: Map<string, string>
}

const BACKUP_DIR_PREFIX = "codenomad-opencode-session-repair-"

function normalizeDirectoryKey(input: string | null | undefined): string {
  const normalized = path.normalize((input ?? "").trim())
  if (!normalized) return ""
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function parseModelValue(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export class OpenCodeSessionRepairService {
  constructor(
    private readonly deps: {
      settings: SettingsService
      binaryResolver: BinaryResolver
      workspaceManager: WorkspaceManager
      logger: Logger
    },
  ) {}

  async analyze(): Promise<OpenCodeSessionRepairAnalysis> {
    const state = this.loadRepairState()
    return this.buildAnalysis(state)
  }

  async repair(mode: OpenCodeSessionRepairMode): Promise<OpenCodeSessionRepairResult> {
    const before = this.loadRepairState()
    const backupPath = await this.createBackup(before.dbPath)
    const db = new DatabaseSync(before.dbPath)

    let repairedAssistantMessages = 0
    let repairedSessionAgents = 0
    let repairedSessionModels = 0
    let repairedSessionPaths = 0
    let repairedSessionDirectories = 0

    try {
      db.exec("BEGIN TRANSACTION")

      if (mode === "important") {
        const rows = db.prepare(`
          SELECT id, data
          FROM message
          WHERE json_extract(data, '$.role') = 'assistant'
            AND json_extract(data, '$.agent') IS NULL
            AND json_extract(data, '$.mode') IS NOT NULL
        `).all() as Array<{ id: string; data: string }>

        const updateMessage = db.prepare("UPDATE message SET data = ? WHERE id = ?")
        for (const row of rows) {
          const data = JSON.parse(row.data) as Record<string, unknown>
          const modeValue = typeof data.mode === "string" ? data.mode.trim() : ""
          if (!modeValue || typeof data.agent === "string") continue
          data.agent = modeValue
          updateMessage.run(JSON.stringify(data), row.id)
          repairedAssistantMessages += 1
        }

      }

      if (mode === "normalize") {
        const updateSession = db.prepare("UPDATE session SET agent = ?, model = ?, path = ? WHERE id = ?")
        for (const session of before.sessions) {
          const missingMessageAgents = before.missingAssistantAgentMessages.get(session.id) ?? 0
          const recommendedDirectory = before.recommendedDirectoryBySession.get(session.id)
          if (missingMessageAgents > 0 || recommendedDirectory) {
            continue
          }

          const derived = before.derivedMetadataBySession.get(session.id) ?? {}
          const nextAgent = session.agent ?? derived.agent ?? null
          const nextModel = session.model ?? derived.model ?? null
          const nextPath = session.path ?? ""

          if (nextAgent === session.agent && nextModel === session.model && nextPath === session.path) continue
          updateSession.run(nextAgent, nextModel, nextPath, session.id)
          if (session.agent === null && nextAgent !== null) repairedSessionAgents += 1
          if (session.model === null && nextModel !== null) repairedSessionModels += 1
          if (session.path === null) repairedSessionPaths += 1
        }
      }

      if (mode === "important") {
        const updateDirectory = db.prepare("UPDATE session SET directory = ? WHERE id = ?")
        for (const [sessionId, targetDirectory] of before.recommendedDirectoryBySession) {
          const session = before.sessions.find((entry) => entry.id === sessionId)
          if (!session) continue
          if (session.directory === targetDirectory) continue
          updateDirectory.run(targetDirectory, sessionId)
          repairedSessionDirectories += 1
        }
      }

      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    } finally {
      db.close()
    }

    const after = await this.analyze()
    return {
      backupPath,
      executedAt: new Date().toISOString(),
      mode,
        repaired: {
          assistantMessages: repairedAssistantMessages,
          sessionAgents: repairedSessionAgents,
          sessionModels: repairedSessionModels,
          sessionPaths: repairedSessionPaths,
          sessionDirectories: repairedSessionDirectories,
        },
      analysis: after,
    }
  }

  private loadRepairState(): SessionRepairState {
    const dbPath = this.resolveDbPath()
    const db = new DatabaseSync(dbPath, { readOnly: true })

    try {
      const sessionRows = db.prepare(`
        SELECT id, project_id AS projectId, title, directory, version, agent, model, path
        FROM session
        ORDER BY time_created
      `).all() as SessionRow[]

      const assistantMessageCountRow = db.prepare(`
        SELECT COUNT(*) AS count
        FROM message
        WHERE json_extract(data, '$.role') = 'assistant'
      `).get() as { count: number }

      const missingAssistantAgentRows = db.prepare(`
        SELECT session_id AS sessionId, COUNT(*) AS count
        FROM message
        WHERE json_extract(data, '$.role') = 'assistant'
          AND json_extract(data, '$.agent') IS NULL
          AND json_extract(data, '$.mode') IS NOT NULL
        GROUP BY session_id
      `).all() as Array<{ sessionId: string; count: number }>

      const derivedMetadataRows = db.prepare(`
        SELECT session_id AS sessionId,
               json_extract(data, '$.mode') AS mode,
               json_extract(data, '$.providerID') AS providerID,
               json_extract(data, '$.modelID') AS modelID,
               json_extract(data, '$.variant') AS variant
        FROM message
        WHERE json_extract(data, '$.role') = 'assistant'
          AND json_extract(data, '$.mode') IS NOT NULL
        ORDER BY session_id, time_created
      `).all() as Array<{ sessionId: string; mode: string | null; providerID: string | null; modelID: string | null; variant: string | null }>

      const missingAssistantAgentMessages = new Map<string, number>()
      for (const row of missingAssistantAgentRows) {
        missingAssistantAgentMessages.set(row.sessionId, row.count)
      }

      const derivedMetadataBySession = new Map<string, DerivedSessionMetadata>()
      for (const row of derivedMetadataRows) {
        if (derivedMetadataBySession.has(row.sessionId)) continue
        const metadata: DerivedSessionMetadata = {}
        if (typeof row.mode === "string" && row.mode.trim()) {
          metadata.agent = row.mode.trim()
        }
        if (typeof row.providerID === "string" && row.providerID.trim() && typeof row.modelID === "string" && row.modelID.trim()) {
          const model: Record<string, string> = {
            id: row.modelID.trim(),
            providerID: row.providerID.trim(),
          }
          if (typeof row.variant === "string" && row.variant.trim()) {
            model.variant = row.variant.trim()
          }
          metadata.model = JSON.stringify(model)
        }
        derivedMetadataBySession.set(row.sessionId, metadata)
      }

      const recommendedDirectoryBySession = this.buildRecommendedDirectoryRepairs(sessionRows, missingAssistantAgentMessages)

      return {
        dbPath,
        assistantMessageCount: assistantMessageCountRow.count,
        sessions: sessionRows,
        missingAssistantAgentMessages,
        derivedMetadataBySession,
        recommendedDirectoryBySession,
      }
    } finally {
      db.close()
    }
  }

  private buildRecommendedDirectoryRepairs(
    sessions: SessionRow[],
    missingAssistantAgentMessages: Map<string, number>,
  ): Map<string, string> {
    const knownDirectories = this.getKnownDirectories()
    const byProject = new Map<string, SessionRow[]>()
    for (const session of sessions) {
      const list = byProject.get(session.projectId) ?? []
      list.push(session)
      byProject.set(session.projectId, list)
    }

    const recommendations = new Map<string, string>()

    for (const projectSessions of byProject.values()) {
      const directories = new Map<string, { display: string; sessions: SessionRow[]; known: boolean }>()
      for (const session of projectSessions) {
        const key = normalizeDirectoryKey(session.directory)
        if (!key) continue
        const existing = directories.get(key)
        if (existing) {
          existing.sessions.push(session)
          continue
        }
        directories.set(key, {
          display: session.directory ?? "",
          sessions: [session],
          known: knownDirectories.has(key),
        })
      }

      if (directories.size <= 1) continue

      const known = Array.from(directories.values()).filter((entry) => entry.known)
      let target: { display: string; sessions: SessionRow[]; known: boolean } | null = null
      if (known.length === 1) {
        target = known[0]
      } else if (known.length === 0) {
        const ordered = Array.from(directories.values()).sort((left, right) => right.sessions.length - left.sessions.length)
        if (ordered.length > 1 && ordered[0].sessions.length > ordered[1].sessions.length && ordered[0].sessions.length > 1) {
          target = ordered[0]
        }
      }

      if (!target) continue

      for (const entry of directories.values()) {
        if (entry.display === target.display) continue
        for (const session of entry.sessions) {
          const missingTopLevel = session.agent === null || session.model === null || session.path === null
          const missingMessages = (missingAssistantAgentMessages.get(session.id) ?? 0) > 0
          if (missingTopLevel || missingMessages) {
            recommendations.set(session.id, target.display)
          }
        }
      }
    }

    return recommendations
  }

  private buildAnalysis(state: SessionRepairState): OpenCodeSessionRepairAnalysis {
    const affectedSessions: OpenCodeSessionRepairIssueSession[] = []
    let sessionsLikelyBroken = 0
    let sessionsLikelyHidden = 0
    let sessionsWithIncompleteMetadataOnly = 0
    let sessionsWithRepairableSafeMetadata = 0
    let sessionsWithRemainingIncompleteMetadata = 0
    let sessionsWithMissingAssistantAgentMessages = 0
    let sessionsMissingSessionAgent = 0
    let sessionsMissingSessionModel = 0
    let sessionsMissingSessionPath = 0

    for (const session of state.sessions) {
      const missingMessageAgents = state.missingAssistantAgentMessages.get(session.id) ?? 0
      const missingSessionAgent = session.agent === null
      const missingSessionModel = session.model === null
      const missingSessionPath = session.path === null
      const recommendedDirectory = state.recommendedDirectoryBySession.get(session.id)
      const likelyBroken = missingMessageAgents > 0
      const likelyHidden = Boolean(recommendedDirectory)
      const metadataIncompleteOnly = !likelyBroken && !likelyHidden && (missingSessionAgent || missingSessionModel || missingSessionPath)
      const derived = state.derivedMetadataBySession.get(session.id) ?? {}
      const repairableSafeMetadata =
        metadataIncompleteOnly &&
        ((missingSessionAgent && Boolean(derived.agent)) ||
          (missingSessionModel && Boolean(derived.model)))

      if (missingMessageAgents > 0) sessionsWithMissingAssistantAgentMessages += 1
      if (missingSessionAgent) sessionsMissingSessionAgent += 1
      if (missingSessionModel) sessionsMissingSessionModel += 1
      if (missingSessionPath) sessionsMissingSessionPath += 1
      if (likelyBroken) sessionsLikelyBroken += 1
      if (likelyHidden) sessionsLikelyHidden += 1
      if (metadataIncompleteOnly) sessionsWithIncompleteMetadataOnly += 1
      if (repairableSafeMetadata) sessionsWithRepairableSafeMetadata += 1
      if (metadataIncompleteOnly && !repairableSafeMetadata) sessionsWithRemainingIncompleteMetadata += 1

      if (missingMessageAgents === 0 && !missingSessionAgent && !missingSessionModel && !missingSessionPath && !recommendedDirectory) {
        continue
      }

      affectedSessions.push({
        id: session.id,
        title: session.title,
        projectId: session.projectId,
        directory: session.directory ?? "",
        version: session.version,
        likelyBroken,
        likelyHidden,
        metadataIncompleteOnly,
        repairableSafeMetadata,
        missingAssistantAgentMessages: missingMessageAgents,
        missingSessionAgent,
        missingSessionModel,
        missingSessionPath,
        recommendedDirectory,
      })
    }

    return {
      analyzedAt: new Date().toISOString(),
      dbPath: state.dbPath,
      sessionCount: state.sessions.length,
      assistantMessageCount: state.assistantMessageCount,
      issues: {
        sessionsLikelyBroken,
        sessionsLikelyHidden,
        sessionsWithIncompleteMetadataOnly,
        sessionsWithRepairableSafeMetadata,
        sessionsWithRemainingIncompleteMetadata,
        sessionsWithMissingAssistantAgentMessages,
        sessionsMissingSessionAgent,
        sessionsMissingSessionModel,
        sessionsMissingSessionPath,
        sessionsWithRecommendedDirectoryRepair: state.recommendedDirectoryBySession.size,
      },
      affectedSessions,
    }
  }

  private getKnownDirectories(): Set<string> {
    const directories = new Set<string>()
    for (const workspace of this.deps.workspaceManager.list()) {
      const key = normalizeDirectoryKey(workspace.path)
      if (key) directories.add(key)
    }

    const uiState = this.deps.settings.getOwner("state", "ui") as { recentFolders?: Array<{ path?: string }> }
    const recentFolders = Array.isArray(uiState?.recentFolders) ? uiState.recentFolders : []
    for (const folder of recentFolders) {
      const key = normalizeDirectoryKey(folder?.path)
      if (key) directories.add(key)
    }

    return directories
  }

  private resolveDbPath(): string {
    const binary = this.deps.binaryResolver.resolveDefault().path
    const spec = buildSpawnSpec(binary, ["db", "path"], { env: process.env })
    const result = spawnSync(spec.command, spec.args, {
      encoding: "utf8",
      cwd: spec.cwd,
      env: spec.env,
      windowsVerbatimArguments: Boolean(spec.options.windowsVerbatimArguments),
    })

    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || "Failed to resolve OpenCode database path").trim())
    }

    const resolved = String(result.stdout ?? "").trim()
    if (!resolved) {
      throw new Error("OpenCode database path is empty")
    }

    return resolved
  }

  private async createBackup(dbPath: string): Promise<string> {
    const backupDir = await fsp.mkdtemp(path.join(os.tmpdir(), BACKUP_DIR_PREFIX))
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backupPath = path.join(backupDir, `opencode-session-repair-${timestamp}.db`)
    const sourceDb = new DatabaseSync(dbPath, { readOnly: true })

    try {
      await backup(sourceDb, backupPath)
    } finally {
      sourceDb.close()
    }

    this.deps.logger.info({ backupPath, dbPath }, "Created OpenCode session repair backup")
    return backupPath
  }
}
