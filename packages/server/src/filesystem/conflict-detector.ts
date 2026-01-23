/**
 * Conflict Detector
 *
 * Orchestrates conflict detection by integrating the file watcher,
 * change tracker, and merge service. Publishes events when conflicts
 * are detected or files are changed.
 */

import * as fs from "fs"
import * as path from "path"
import { randomUUID } from "crypto"
import { Mutex } from "async-mutex"
import { FileWatchService, FileChangeEvent, createFileWatchService } from "./file-watch-service.js"
import { FileChangeTracker, FileVersion, getFileChangeTracker } from "./file-change-tracker.js"
import { MergeService, MergeResult, ConflictRegion, getMergeService } from "./merge-service.js"
import { isBinaryFile } from "./binary-detector.js"
import { EventBus } from "../events/bus.js"
import { createLogger, Logger } from "../logger.js"

// Re-export types
export type { FileChangeEvent } from "./file-watch-service.js"
export type { MergeResult, ConflictRegion } from "./merge-service.js"

export type ConflictType = "concurrent-write" | "external-change" | "merge-conflict"

export interface SessionInfo {
  sessionId: string
  instanceId: string
  hash: string
  timestamp: number
}

export interface FileConflict {
  /** Unique conflict ID */
  conflictId: string
  /** Relative file path */
  filePath: string
  /** Absolute file path */
  absolutePath: string
  /** Type of conflict */
  conflictType: ConflictType
  /** Sessions involved in the conflict */
  involvedSessions: SessionInfo[]
  /** Merge result if auto-merge was attempted */
  mergeResult: {
    canAutoMerge: boolean
    mergedContent?: string
    conflicts?: ConflictRegion[]
  }
  /** When the conflict was detected */
  timestamp: number
  /** Whether the file is binary */
  isBinary: boolean
}

export interface FileChangedEventData {
  type: "file.changed"
  filePath: string
  absolutePath: string
  changeType: "add" | "change" | "unlink"
  sessionId: string
  instanceId: string
  hash: string
  previousHash?: string
  timestamp: number
  affectedSessions: string[]
}

export interface FileConflictEventData {
  type: "file.conflict"
  conflictId: string
  filePath: string
  absolutePath: string
  conflictType: ConflictType
  involvedSessions: SessionInfo[]
  mergeResult: {
    canAutoMerge: boolean
    mergedContent?: string
    conflicts?: ConflictRegion[]
  }
  timestamp: number
}

export interface FileConflictResolvedEventData {
  type: "file.conflict.resolved"
  conflictId: string
  filePath: string
  resolution: "auto-merged" | "keep-ours" | "keep-theirs" | "manual"
  resolvedBy: string
  newHash: string
  timestamp: number
}

export type FileEventData =
  | FileChangedEventData
  | FileConflictEventData
  | FileConflictResolvedEventData

export interface ConflictDetectorOptions {
  /** Workspace root path */
  workspaceRoot: string
  /** Event bus for publishing events */
  eventBus: EventBus
  /** File change tracker (optional, uses singleton) */
  tracker?: FileChangeTracker
  /** Merge service (optional, uses singleton) */
  merger?: MergeService
  /** File watch service (optional, creates new) */
  watcher?: FileWatchService
  /** Logger instance */
  logger?: Logger
  /** Whether to start file watcher automatically */
  autoStart?: boolean
}

export class ConflictDetector {
  private workspaceRoot: string
  private eventBus: EventBus
  private tracker: FileChangeTracker
  private merger: MergeService
  private watcher: FileWatchService
  private log: Logger

  // Active conflicts keyed by file path
  private activeConflicts: Map<string, FileConflict> = new Map()
  // Mutex for conflict detection to prevent race conditions
  private detectionMutex: Mutex = new Mutex()
  // Track expected hashes per session to detect external changes
  private sessionExpectedHashes: Map<string, Map<string, string>> = new Map()

  constructor(options: ConflictDetectorOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot)
    this.eventBus = options.eventBus
    this.tracker = options.tracker ?? getFileChangeTracker()
    this.merger = options.merger ?? getMergeService()
    this.log = options.logger ?? createLogger({ component: "conflict-detector" })

    // Create or use provided watcher
    this.watcher = options.watcher ?? createFileWatchService({
      workspaceRoot: this.workspaceRoot,
      logger: this.log,
    })

    // Subscribe to file changes
    this.watcher.onFileChange((event) => this.handleFileChange(event))

    // Auto-start watcher if requested
    if (options.autoStart !== false) {
      this.start()
    }
  }

  /**
   * Start the conflict detector and file watcher
   */
  start(): void {
    if (!this.watcher.running()) {
      this.watcher.start()
      this.log.info({ workspaceRoot: this.workspaceRoot }, "Conflict detector started")
    }
  }

  /**
   * Stop the conflict detector
   */
  async stop(): Promise<void> {
    await this.watcher.stop()
    this.log.info({}, "Conflict detector stopped")
  }

  /**
   * Register that a session is reading a file
   */
  async registerRead(
    absolutePath: string,
    sessionId: string,
    instanceId: string
  ): Promise<{ hash: string; content: string }> {
    const content = await this.readFileContent(absolutePath)
    const hash = this.tracker.computeHash(content)
    const isBinary = this.merger.isBinary(content, absolutePath).isBinary

    this.tracker.registerRead(absolutePath, sessionId, instanceId, content, isBinary)

    // Track expected hash for this session
    this.setSessionExpectedHash(sessionId, absolutePath, hash)

    this.log.debug(
      { path: path.relative(this.workspaceRoot, absolutePath), sessionId, hash },
      "Registered file read"
    )

    return { hash, content }
  }

  /**
   * Register that a session is writing a file
   * Returns a conflict if one is detected
   */
  async registerWrite(
    absolutePath: string,
    sessionId: string,
    instanceId: string,
    content: string,
    expectedHash?: string
  ): Promise<{ success: boolean; hash: string; conflict?: FileConflict }> {
    return this.detectionMutex.runExclusive(async () => {
      const relativePath = path.relative(this.workspaceRoot, absolutePath)
      const newHash = this.tracker.computeHash(content)
      const isBinary = this.merger.isBinary(content, absolutePath).isBinary

      // Check for concurrent changes
      const tracked = this.tracker.getTrackedFile(absolutePath)
      const sessionExpected = this.getSessionExpectedHash(sessionId, absolutePath)
      const checkHash = expectedHash ?? sessionExpected

      if (tracked && checkHash && tracked.currentHash !== checkHash) {
        // Conflict detected
        this.log.info(
          {
            path: relativePath,
            sessionId,
            expectedHash: checkHash,
            currentHash: tracked.currentHash,
          },
          "Conflict detected during write"
        )

        const conflict = await this.createConflict(
          absolutePath,
          sessionId,
          instanceId,
          content,
          newHash,
          tracked,
          "concurrent-write"
        )

        return { success: false, hash: newHash, conflict }
      }

      // No conflict, register the write
      this.tracker.registerWrite(absolutePath, sessionId, instanceId, content, newHash, isBinary)
      this.setSessionExpectedHash(sessionId, absolutePath, newHash)

      // Notify other sessions about the change
      const affectedSessions = this.tracker.getAffectedSessions(absolutePath)
        .filter((s) => s !== sessionId)

      if (affectedSessions.length > 0) {
        const event: FileChangedEventData = {
          type: "file.changed",
          filePath: relativePath,
          absolutePath,
          changeType: "change",
          sessionId,
          instanceId,
          hash: newHash,
          previousHash: tracked?.currentHash,
          timestamp: Date.now(),
          affectedSessions,
        }

        this.publishEvent(event)
      }

      return { success: true, hash: newHash }
    })
  }

  /**
   * Handle file change events from the watcher
   */
  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    // Skip agent-reported changes (we already handle those in registerWrite)
    if (event.detectedBy === "agent-report") {
      return
    }

    await this.detectionMutex.runExclusive(async () => {
      const relativePath = event.path
      const absolutePath = event.absolutePath

      this.log.debug(
        { type: event.type, path: relativePath },
        "Processing file change from watcher"
      )

      // Get tracked file info
      const tracked = this.tracker.getTrackedFile(absolutePath)

      if (!tracked || tracked.readers.size === 0) {
        // File not tracked by any session, ignore
        return
      }

      if (event.type === "unlink") {
        // File deleted - notify all sessions
        const affectedSessions = Array.from(tracked.readers)

        const eventData: FileChangedEventData = {
          type: "file.changed",
          filePath: relativePath,
          absolutePath,
          changeType: "unlink",
          sessionId: "external",
          instanceId: "external",
          hash: "",
          previousHash: tracked.currentHash,
          timestamp: event.timestamp,
          affectedSessions,
        }

        this.publishEvent(eventData)
        this.tracker.untrackFile(absolutePath)
        return
      }

      // File added or changed - check for conflicts
      let currentContent: string
      try {
        currentContent = await this.readFileContent(absolutePath)
      } catch (error) {
        this.log.warn({ path: relativePath, error }, "Failed to read changed file")
        return
      }

      const currentHash = this.tracker.computeHash(currentContent)

      // Check if hash actually changed
      if (currentHash === tracked.currentHash) {
        return
      }

      // External change detected
      this.log.info(
        { path: relativePath, oldHash: tracked.currentHash, newHash: currentHash },
        "External file change detected"
      )

      // Check each session for conflicts
      const affectedSessions = Array.from(tracked.readers)
      const conflictingSessions: SessionInfo[] = []

      for (const sessionId of affectedSessions) {
        const expectedHash = this.getSessionExpectedHash(sessionId, absolutePath)
        if (expectedHash && expectedHash !== currentHash) {
          // This session has a different expected hash
          const versions = this.tracker.getFileHistory(absolutePath)
          const sessionVersion = versions.find(
            (v) => v.sessionId === sessionId && v.hash === expectedHash
          )

          conflictingSessions.push({
            sessionId,
            instanceId: sessionVersion?.instanceId ?? "unknown",
            hash: expectedHash,
            timestamp: sessionVersion?.timestamp ?? Date.now(),
          })
        }
      }

      if (conflictingSessions.length > 0) {
        // Create external change conflict
        const conflict = await this.createExternalConflict(
          absolutePath,
          currentContent,
          currentHash,
          conflictingSessions,
          tracked
        )

        if (conflict) {
          return
        }
      }

      // No conflicts, just notify about the change
      const eventData: FileChangedEventData = {
        type: "file.changed",
        filePath: relativePath,
        absolutePath,
        changeType: event.type === "add" ? "add" : "change",
        sessionId: "external",
        instanceId: "external",
        hash: currentHash,
        previousHash: tracked.currentHash,
        timestamp: event.timestamp,
        affectedSessions,
      }

      this.publishEvent(eventData)

      // Update tracker with new content
      this.tracker.registerWrite(
        absolutePath,
        "external",
        "external",
        currentContent,
        currentHash,
        this.merger.isBinary(currentContent, absolutePath).isBinary
      )
    })
  }

  /**
   * Create a conflict from a concurrent write
   */
  private async createConflict(
    absolutePath: string,
    sessionId: string,
    instanceId: string,
    newContent: string,
    newHash: string,
    tracked: ReturnType<FileChangeTracker["getTrackedFile"]>,
    conflictType: ConflictType
  ): Promise<FileConflict> {
    const relativePath = path.relative(this.workspaceRoot, absolutePath)
    const conflictId = randomUUID()

    // Get current content from disk
    let currentContent: string
    try {
      currentContent = await this.readFileContent(absolutePath)
    } catch {
      currentContent = ""
    }

    // Find base version (common ancestor)
    const history = this.tracker.getFileHistory(absolutePath)
    const baseVersion = history.length > 0 ? history[0] : null
    const baseContent = baseVersion?.content ?? ""

    // Attempt 3-way merge
    const mergeResult = this.merger.merge({
      filePath: relativePath,
      base: baseContent,
      ours: newContent,
      theirs: currentContent,
    })

    const isBinary = this.merger.isBinary(newContent, absolutePath).isBinary

    const conflict: FileConflict = {
      conflictId,
      filePath: relativePath,
      absolutePath,
      conflictType,
      involvedSessions: [
        {
          sessionId,
          instanceId,
          hash: newHash,
          timestamp: Date.now(),
        },
        {
          sessionId: tracked?.versions[tracked.versions.length - 1]?.sessionId ?? "unknown",
          instanceId: tracked?.versions[tracked.versions.length - 1]?.instanceId ?? "unknown",
          hash: tracked?.currentHash ?? "",
          timestamp: tracked?.lastModified ?? Date.now(),
        },
      ],
      mergeResult: {
        canAutoMerge: mergeResult.success,
        mergedContent: mergeResult.success ? mergeResult.merged ?? undefined : undefined,
        conflicts: mergeResult.conflicts,
      },
      timestamp: Date.now(),
      isBinary,
    }

    this.activeConflicts.set(absolutePath, conflict)

    // Publish conflict event
    const eventData: FileConflictEventData = {
      type: "file.conflict",
      conflictId: conflict.conflictId,
      filePath: conflict.filePath,
      absolutePath: conflict.absolutePath,
      conflictType: conflict.conflictType,
      involvedSessions: conflict.involvedSessions,
      mergeResult: conflict.mergeResult,
      timestamp: conflict.timestamp,
    }

    this.publishEvent(eventData)

    return conflict
  }

  /**
   * Create a conflict from external change
   */
  private async createExternalConflict(
    absolutePath: string,
    currentContent: string,
    currentHash: string,
    conflictingSessions: SessionInfo[],
    tracked: ReturnType<FileChangeTracker["getTrackedFile"]>
  ): Promise<FileConflict | null> {
    const relativePath = path.relative(this.workspaceRoot, absolutePath)
    const conflictId = randomUUID()

    // Get base version
    const history = this.tracker.getFileHistory(absolutePath)
    const baseVersion = history.length > 0 ? history[0] : null
    const baseContent = baseVersion?.content ?? ""

    // Get the first conflicting session's content
    const firstSession = conflictingSessions[0]
    const sessionVersion = history.find(
      (v) => v.sessionId === firstSession.sessionId && v.hash === firstSession.hash
    )
    const sessionContent = sessionVersion?.content ?? ""

    if (!sessionContent) {
      // Can't merge without session content
      this.log.warn({ path: relativePath }, "Cannot create conflict: session content not cached")
      return null
    }

    // Attempt 3-way merge
    const mergeResult = this.merger.merge({
      filePath: relativePath,
      base: baseContent,
      ours: sessionContent,
      theirs: currentContent,
    })

    const isBinary = this.merger.isBinary(currentContent, absolutePath).isBinary

    const conflict: FileConflict = {
      conflictId,
      filePath: relativePath,
      absolutePath,
      conflictType: "external-change",
      involvedSessions: [
        ...conflictingSessions,
        {
          sessionId: "external",
          instanceId: "external",
          hash: currentHash,
          timestamp: Date.now(),
        },
      ],
      mergeResult: {
        canAutoMerge: mergeResult.success,
        mergedContent: mergeResult.success ? mergeResult.merged ?? undefined : undefined,
        conflicts: mergeResult.conflicts,
      },
      timestamp: Date.now(),
      isBinary,
    }

    this.activeConflicts.set(absolutePath, conflict)

    // Publish conflict event
    const eventData: FileConflictEventData = {
      type: "file.conflict",
      conflictId: conflict.conflictId,
      filePath: conflict.filePath,
      absolutePath: conflict.absolutePath,
      conflictType: conflict.conflictType,
      involvedSessions: conflict.involvedSessions,
      mergeResult: conflict.mergeResult,
      timestamp: conflict.timestamp,
    }

    this.publishEvent(eventData)

    return conflict
  }

  /**
   * Resolve a conflict
   */
  async resolveConflict(
    conflictId: string,
    resolution: "auto-merged" | "keep-ours" | "keep-theirs" | "manual",
    resolvedBy: string,
    content?: string
  ): Promise<{ success: boolean; newHash: string; error?: string }> {
    // Find the conflict
    let conflict: FileConflict | undefined
    let filePath: string | undefined

    for (const [path, c] of this.activeConflicts) {
      if (c.conflictId === conflictId) {
        conflict = c
        filePath = path
        break
      }
    }

    if (!conflict || !filePath) {
      return { success: false, newHash: "", error: "Conflict not found" }
    }

    let resolvedContent: string

    switch (resolution) {
      case "auto-merged":
        if (!conflict.mergeResult.canAutoMerge || !conflict.mergeResult.mergedContent) {
          return { success: false, newHash: "", error: "Auto-merge not available" }
        }
        resolvedContent = conflict.mergeResult.mergedContent
        break

      case "keep-ours":
        // Find the "ours" content from the first non-external session
        const oursSession = conflict.involvedSessions.find((s) => s.sessionId !== "external")
        if (!oursSession) {
          return { success: false, newHash: "", error: "Cannot determine 'ours' version" }
        }
        const oursVersion = this.tracker.getVersionByHash(conflict.absolutePath, oursSession.hash)
        if (!oursVersion?.content) {
          return { success: false, newHash: "", error: "'Ours' content not available" }
        }
        resolvedContent = oursVersion.content
        break

      case "keep-theirs":
        // Read current file content
        try {
          resolvedContent = await this.readFileContent(conflict.absolutePath)
        } catch {
          return { success: false, newHash: "", error: "Cannot read current file content" }
        }
        break

      case "manual":
        if (!content) {
          return { success: false, newHash: "", error: "Content required for manual resolution" }
        }
        resolvedContent = content
        break

      default:
        return { success: false, newHash: "", error: "Invalid resolution type" }
    }

    // Write the resolved content
    try {
      await fs.promises.writeFile(conflict.absolutePath, resolvedContent, "utf8")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      return { success: false, newHash: "", error: `Failed to write file: ${message}` }
    }

    const newHash = this.tracker.computeHash(resolvedContent)

    // Update tracker
    this.tracker.registerWrite(
      conflict.absolutePath,
      resolvedBy,
      "resolution",
      resolvedContent,
      newHash,
      conflict.isBinary
    )

    // Update expected hashes for all involved sessions
    for (const session of conflict.involvedSessions) {
      if (session.sessionId !== "external") {
        this.setSessionExpectedHash(session.sessionId, conflict.absolutePath, newHash)
      }
    }

    // Remove from active conflicts
    this.activeConflicts.delete(filePath)

    // Publish resolved event
    const eventData: FileConflictResolvedEventData = {
      type: "file.conflict.resolved",
      conflictId,
      filePath: conflict.filePath,
      resolution,
      resolvedBy,
      newHash,
      timestamp: Date.now(),
    }

    this.publishEvent(eventData)

    this.log.info(
      { conflictId, filePath: conflict.filePath, resolution, resolvedBy },
      "Conflict resolved"
    )

    return { success: true, newHash }
  }

  /**
   * Get all active conflicts
   */
  getActiveConflicts(): FileConflict[] {
    return Array.from(this.activeConflicts.values())
  }

  /**
   * Get conflict by ID
   */
  getConflict(conflictId: string): FileConflict | undefined {
    for (const conflict of this.activeConflicts.values()) {
      if (conflict.conflictId === conflictId) {
        return conflict
      }
    }
    return undefined
  }

  /**
   * Get conflict by file path
   */
  getConflictByPath(absolutePath: string): FileConflict | undefined {
    return this.activeConflicts.get(absolutePath)
  }

  /**
   * Unregister a session from the tracker
   */
  unregisterSession(sessionId: string): void {
    this.tracker.unregisterSession(sessionId)
    this.sessionExpectedHashes.delete(sessionId)
    this.log.debug({ sessionId }, "Session unregistered from conflict detector")
  }

  /**
   * Clear all tracking state (for testing)
   */
  clear(): void {
    this.activeConflicts.clear()
    this.sessionExpectedHashes.clear()
    this.tracker.clear()
    this.log.debug({}, "Conflict detector state cleared")
  }

  /**
   * Get the file change tracker
   */
  getTracker(): FileChangeTracker {
    return this.tracker
  }

  /**
   * Get the merge service
   */
  getMerger(): MergeService {
    return this.merger
  }

  /**
   * Get the file watcher
   */
  getWatcher(): FileWatchService {
    return this.watcher
  }

  /**
   * Read file content
   */
  private async readFileContent(absolutePath: string): Promise<string> {
    return fs.promises.readFile(absolutePath, "utf8")
  }

  /**
   * Set expected hash for a session
   */
  private setSessionExpectedHash(sessionId: string, absolutePath: string, hash: string): void {
    if (!this.sessionExpectedHashes.has(sessionId)) {
      this.sessionExpectedHashes.set(sessionId, new Map())
    }
    this.sessionExpectedHashes.get(sessionId)!.set(absolutePath, hash)
  }

  /**
   * Get expected hash for a session
   */
  private getSessionExpectedHash(sessionId: string, absolutePath: string): string | undefined {
    return this.sessionExpectedHashes.get(sessionId)?.get(absolutePath)
  }

  /**
   * Publish an event to the event bus
   */
  private publishEvent(event: FileEventData): void {
    // The event bus expects a specific payload type, so we cast
    this.eventBus.publish(event as any)
  }
}

// Singleton instance per workspace
const detectorInstances: Map<string, ConflictDetector> = new Map()

export function getConflictDetector(workspaceRoot: string): ConflictDetector | undefined {
  return detectorInstances.get(path.resolve(workspaceRoot))
}

export function createConflictDetector(options: ConflictDetectorOptions): ConflictDetector {
  const normalizedRoot = path.resolve(options.workspaceRoot)

  // Return existing if available
  const existing = detectorInstances.get(normalizedRoot)
  if (existing) {
    return existing
  }

  const detector = new ConflictDetector(options)
  detectorInstances.set(normalizedRoot, detector)
  return detector
}

export function removeConflictDetector(workspaceRoot: string): void {
  const normalizedRoot = path.resolve(workspaceRoot)
  const detector = detectorInstances.get(normalizedRoot)
  if (detector) {
    detector.stop()
    detectorInstances.delete(normalizedRoot)
  }
}
