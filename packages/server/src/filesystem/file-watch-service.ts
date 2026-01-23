/**
 * File Watch Service
 *
 * Watches filesystem for changes using chokidar and emits events
 * for file additions, modifications, deletions, and renames.
 * Integrates with the EventBus to broadcast changes to all connected clients.
 */

import chokidar, { FSWatcher } from "chokidar"
import * as path from "path"
import * as fs from "fs"
import { createLogger, Logger } from "../logger.js"

export interface FileChangeEvent {
  type: "add" | "change" | "unlink" | "rename"
  /** Relative path from workspace root */
  path: string
  /** Absolute path on disk */
  absolutePath: string
  /** When the change was detected */
  timestamp: number
  /** File stats if available */
  stats?: {
    size: number
    mtime: number
    isDirectory: boolean
  }
  /** How the change was detected */
  detectedBy: "watcher" | "agent-report"
}

export interface FileWatchServiceOptions {
  /** Root directory to watch */
  workspaceRoot: string
  /** Debounce interval in ms (default: 150) */
  debounceMs?: number
  /** Glob patterns to ignore */
  ignoredPatterns?: string[]
  /** Whether to follow symlinks (default: true) */
  followSymlinks?: boolean
  /** Logger instance */
  logger?: Logger
}

type FileChangeHandler = (event: FileChangeEvent) => void

const DEFAULT_IGNORED_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.era/cache/**",
  "**/*.log",
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/*.swp",
  "**/*.swo",
  "**/*~",
  "**/.idea/**",
  "**/.vscode/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/coverage/**",
  "**/__pycache__/**",
  "**/*.pyc",
  "**/target/**",
  "**/vendor/**",
]

export class FileWatchService {
  private watcher: FSWatcher | null = null
  private workspaceRoot: string
  private debounceMs: number
  private ignoredPatterns: string[]
  private followSymlinks: boolean
  private handlers: Set<FileChangeHandler> = new Set()
  private pendingEvents: Map<string, FileChangeEvent> = new Map()
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map()
  private log: Logger
  private isRunning = false

  constructor(options: FileWatchServiceOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot)
    this.debounceMs = options.debounceMs ?? 150
    this.ignoredPatterns = options.ignoredPatterns ?? DEFAULT_IGNORED_PATTERNS
    this.followSymlinks = options.followSymlinks ?? true
    this.log = options.logger ?? createLogger({ component: "file-watch" })
  }

  /**
   * Start watching the workspace root
   */
  start(): void {
    if (this.isRunning) {
      this.log.warn({}, "File watch service already running")
      return
    }

    this.log.info({ workspaceRoot: this.workspaceRoot }, "Starting file watch service")

    this.watcher = chokidar.watch(this.workspaceRoot, {
      ignored: this.ignoredPatterns,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: this.followSymlinks,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
      // Use polling on network drives for reliability
      usePolling: false,
      // Reduce CPU usage
      interval: 100,
      binaryInterval: 300,
    })

    this.watcher
      .on("add", (filePath, stats) => this.handleEvent("add", filePath, stats))
      .on("change", (filePath, stats) => this.handleEvent("change", filePath, stats))
      .on("unlink", (filePath) => this.handleEvent("unlink", filePath))
      .on("error", (error) => this.handleError(error))
      .on("ready", () => {
        this.isRunning = true
        this.log.info({}, "File watcher ready")
      })
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (!this.watcher) {
      return
    }

    this.log.info({}, "Stopping file watch service")

    // Clear all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
    this.pendingEvents.clear()

    await this.watcher.close()
    this.watcher = null
    this.isRunning = false
  }

  /**
   * Check if the service is running
   */
  running(): boolean {
    return this.isRunning
  }

  /**
   * Add a pattern to the ignore list
   */
  addIgnorePattern(pattern: string): void {
    if (!this.ignoredPatterns.includes(pattern)) {
      this.ignoredPatterns.push(pattern)
      // Chokidar doesn't support dynamic ignore updates,
      // so we'd need to restart the watcher for this to take effect
      this.log.debug({ pattern }, "Added ignore pattern (restart required)")
    }
  }

  /**
   * Remove a pattern from the ignore list
   */
  removeIgnorePattern(pattern: string): void {
    const index = this.ignoredPatterns.indexOf(pattern)
    if (index !== -1) {
      this.ignoredPatterns.splice(index, 1)
      this.log.debug({ pattern }, "Removed ignore pattern (restart required)")
    }
  }

  /**
   * Get current ignore patterns
   */
  getIgnorePatterns(): string[] {
    return [...this.ignoredPatterns]
  }

  /**
   * Register a handler for file change events
   */
  onFileChange(handler: FileChangeHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /**
   * Manually report a file change (used by agents)
   */
  reportChange(
    type: FileChangeEvent["type"],
    absolutePath: string,
    stats?: FileChangeEvent["stats"]
  ): void {
    const event = this.createEvent(type, absolutePath, stats, "agent-report")
    this.emitEvent(event)
  }

  /**
   * Get the workspace root
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot
  }

  /**
   * Handle a raw chokidar event
   */
  private handleEvent(
    type: FileChangeEvent["type"],
    absolutePath: string,
    stats?: fs.Stats
  ): void {
    const normalizedPath = path.normalize(absolutePath)

    // Create the event
    const event = this.createEvent(
      type,
      normalizedPath,
      stats
        ? {
            size: stats.size,
            mtime: stats.mtimeMs,
            isDirectory: stats.isDirectory(),
          }
        : undefined,
      "watcher"
    )

    // Debounce: cancel any pending timer for this path and set a new one
    const existingTimer = this.debounceTimers.get(normalizedPath)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Store the latest event for this path
    this.pendingEvents.set(normalizedPath, event)

    // Set a new debounce timer
    const timer = setTimeout(() => {
      const pendingEvent = this.pendingEvents.get(normalizedPath)
      if (pendingEvent) {
        this.emitEvent(pendingEvent)
        this.pendingEvents.delete(normalizedPath)
      }
      this.debounceTimers.delete(normalizedPath)
    }, this.debounceMs)

    this.debounceTimers.set(normalizedPath, timer)
  }

  /**
   * Create a FileChangeEvent from raw data
   */
  private createEvent(
    type: FileChangeEvent["type"],
    absolutePath: string,
    stats?: FileChangeEvent["stats"],
    detectedBy: FileChangeEvent["detectedBy"] = "watcher"
  ): FileChangeEvent {
    // Compute relative path from workspace root
    let relativePath = path.relative(this.workspaceRoot, absolutePath)
    // Normalize to forward slashes for consistency
    relativePath = relativePath.replace(/\\/g, "/")

    return {
      type,
      path: relativePath,
      absolutePath,
      timestamp: Date.now(),
      stats,
      detectedBy,
    }
  }

  /**
   * Emit an event to all handlers
   */
  private emitEvent(event: FileChangeEvent): void {
    this.log.debug(
      {
        type: event.type,
        path: event.path,
        detectedBy: event.detectedBy,
      },
      "File change event"
    )

    for (const handler of this.handlers) {
      try {
        handler(event)
      } catch (error) {
        this.log.error(
          { error, path: event.path },
          "Error in file change handler"
        )
      }
    }
  }

  /**
   * Handle watcher errors
   */
  private handleError(error: Error): void {
    this.log.error({ error }, "File watcher error")
  }
}

/**
 * Create a file watch service singleton for a workspace
 */
let watchServices: Map<string, FileWatchService> = new Map()

export function getFileWatchService(workspaceRoot: string): FileWatchService | undefined {
  const normalizedRoot = path.resolve(workspaceRoot)
  return watchServices.get(normalizedRoot)
}

export function createFileWatchService(options: FileWatchServiceOptions): FileWatchService {
  const normalizedRoot = path.resolve(options.workspaceRoot)

  // Return existing service if one exists for this root
  const existing = watchServices.get(normalizedRoot)
  if (existing) {
    return existing
  }

  const service = new FileWatchService(options)
  watchServices.set(normalizedRoot, service)
  return service
}

export function removeFileWatchService(workspaceRoot: string): void {
  const normalizedRoot = path.resolve(workspaceRoot)
  const service = watchServices.get(normalizedRoot)
  if (service) {
    service.stop()
    watchServices.delete(normalizedRoot)
  }
}
