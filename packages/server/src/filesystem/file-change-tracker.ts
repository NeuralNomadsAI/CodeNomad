/**
 * File Change Tracker
 *
 * Tracks which sessions have read/written which files and maintains
 * version history for 3-way merge operations. Enhances the content
 * hash tracker with multi-session awareness.
 */

import { createHash } from "crypto"
import * as fs from "fs"
import * as path from "path"
import { createLogger, Logger } from "../logger.js"

export interface FileVersion {
  /** SHA-256 hash of the content (truncated to 16 hex chars) */
  hash: string
  /** When this version was recorded */
  timestamp: number
  /** Session that created this version */
  sessionId: string
  /** Instance within the session */
  instanceId: string
  /** Cached content for recent small files (< 100KB) */
  content?: string
}

export interface TrackedFile {
  /** Relative path from workspace root */
  path: string
  /** Absolute path on disk */
  absolutePath: string
  /** Current content hash */
  currentHash: string
  /** Whether this is a binary file */
  isBinary: boolean
  /** File size in bytes */
  size: number
  /** Sessions that have read this file */
  readers: Set<string>
  /** Sessions that have written this file */
  writers: Set<string>
  /** Version history (circular buffer, max entries) */
  versions: FileVersion[]
  /** Last known modification time */
  lastModified: number
}

export interface FileChangeTrackerOptions {
  /** Maximum number of versions to keep per file */
  maxVersionsPerFile?: number
  /** Maximum file size to cache content (in bytes) */
  maxCacheSize?: number
  /** Logger instance */
  logger?: Logger
}

const DEFAULT_MAX_VERSIONS = 10
const DEFAULT_MAX_CACHE_SIZE = 100 * 1024 // 100KB

export class FileChangeTracker {
  private files: Map<string, TrackedFile> = new Map()
  private sessionFiles: Map<string, Set<string>> = new Map() // sessionId -> Set of file paths
  private maxVersionsPerFile: number
  private maxCacheSize: number
  private log: Logger

  constructor(options: FileChangeTrackerOptions = {}) {
    this.maxVersionsPerFile = options.maxVersionsPerFile ?? DEFAULT_MAX_VERSIONS
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE
    this.log = options.logger ?? createLogger({ component: "file-change-tracker" })
  }

  /**
   * Normalize file path for consistent tracking
   */
  private normalizePath(filePath: string): string {
    return path.normalize(filePath).replace(/\\/g, "/").toLowerCase()
  }

  /**
   * Compute SHA-256 hash of content, truncated to 16 hex chars
   */
  computeHash(content: string | Buffer): string {
    const data = typeof content === "string" ? content : content.toString("utf8")
    return createHash("sha256").update(data, "utf8").digest("hex").slice(0, 16)
  }

  /**
   * Register that a session has read a file
   */
  registerRead(
    absolutePath: string,
    sessionId: string,
    instanceId: string,
    content?: string,
    isBinary: boolean = false
  ): void {
    const normalizedPath = this.normalizePath(absolutePath)
    let file = this.files.get(normalizedPath)

    const hash = content ? this.computeHash(content) : this.computeHashFromDisk(absolutePath)
    const stats = this.getFileStats(absolutePath)

    if (!file) {
      file = {
        path: normalizedPath,
        absolutePath,
        currentHash: hash,
        isBinary,
        size: stats?.size ?? 0,
        readers: new Set(),
        writers: new Set(),
        versions: [],
        lastModified: stats?.mtimeMs ?? Date.now(),
      }
      this.files.set(normalizedPath, file)
    }

    // Add reader
    file.readers.add(sessionId)

    // Track session -> files mapping
    if (!this.sessionFiles.has(sessionId)) {
      this.sessionFiles.set(sessionId, new Set())
    }
    this.sessionFiles.get(sessionId)!.add(normalizedPath)

    // Add version if content provided and file is not binary
    if (content && !isBinary) {
      this.addVersion(file, hash, sessionId, instanceId, content)
    }

    this.log.debug(
      { path: normalizedPath, sessionId, instanceId, hash },
      "Registered file read"
    )
  }

  /**
   * Register that a session has written a file
   */
  registerWrite(
    absolutePath: string,
    sessionId: string,
    instanceId: string,
    content: string,
    hash?: string,
    isBinary: boolean = false
  ): void {
    const normalizedPath = this.normalizePath(absolutePath)
    let file = this.files.get(normalizedPath)
    const computedHash = hash ?? this.computeHash(content)
    const stats = this.getFileStats(absolutePath)

    if (!file) {
      file = {
        path: normalizedPath,
        absolutePath,
        currentHash: computedHash,
        isBinary,
        size: stats?.size ?? content.length,
        readers: new Set(),
        writers: new Set(),
        versions: [],
        lastModified: stats?.mtimeMs ?? Date.now(),
      }
      this.files.set(normalizedPath, file)
    }

    // Update current hash
    const previousHash = file.currentHash
    file.currentHash = computedHash
    file.size = stats?.size ?? content.length
    file.lastModified = stats?.mtimeMs ?? Date.now()
    file.isBinary = isBinary

    // Add writer
    file.writers.add(sessionId)

    // Track session -> files mapping
    if (!this.sessionFiles.has(sessionId)) {
      this.sessionFiles.set(sessionId, new Set())
    }
    this.sessionFiles.get(sessionId)!.add(normalizedPath)

    // Add version if not binary
    if (!isBinary) {
      this.addVersion(file, computedHash, sessionId, instanceId, content)
    }

    this.log.debug(
      { path: normalizedPath, sessionId, instanceId, hash: computedHash, previousHash },
      "Registered file write"
    )
  }

  /**
   * Add a version to the file's history
   */
  private addVersion(
    file: TrackedFile,
    hash: string,
    sessionId: string,
    instanceId: string,
    content?: string
  ): void {
    // Don't add duplicate consecutive versions
    if (file.versions.length > 0 && file.versions[file.versions.length - 1].hash === hash) {
      return
    }

    const version: FileVersion = {
      hash,
      timestamp: Date.now(),
      sessionId,
      instanceId,
    }

    // Cache content for small files
    if (content && content.length <= this.maxCacheSize) {
      version.content = content
    }

    file.versions.push(version)

    // Maintain circular buffer
    if (file.versions.length > this.maxVersionsPerFile) {
      file.versions.shift()
    }
  }

  /**
   * Get all sessions that have worked with a file
   */
  getAffectedSessions(absolutePath: string): string[] {
    const normalizedPath = this.normalizePath(absolutePath)
    const file = this.files.get(normalizedPath)
    if (!file) {
      return []
    }

    const sessions = new Set<string>()
    for (const reader of file.readers) {
      sessions.add(reader)
    }
    for (const writer of file.writers) {
      sessions.add(writer)
    }
    return Array.from(sessions)
  }

  /**
   * Get sessions that have read a file
   */
  getReaders(absolutePath: string): string[] {
    const normalizedPath = this.normalizePath(absolutePath)
    const file = this.files.get(normalizedPath)
    return file ? Array.from(file.readers) : []
  }

  /**
   * Get sessions that have written a file
   */
  getWriters(absolutePath: string): string[] {
    const normalizedPath = this.normalizePath(absolutePath)
    const file = this.files.get(normalizedPath)
    return file ? Array.from(file.writers) : []
  }

  /**
   * Get file version history
   */
  getFileHistory(absolutePath: string): FileVersion[] {
    const normalizedPath = this.normalizePath(absolutePath)
    const file = this.files.get(normalizedPath)
    return file ? [...file.versions] : []
  }

  /**
   * Find a common base version between two sessions
   */
  getCommonBase(
    absolutePath: string,
    sessionA: string,
    sessionB: string
  ): FileVersion | null {
    const normalizedPath = this.normalizePath(absolutePath)
    const file = this.files.get(normalizedPath)
    if (!file) {
      return null
    }

    // Find the most recent version before both sessions started modifying
    // This is a simplified approach - a more sophisticated implementation
    // would track per-session version vectors
    const versions = file.versions

    // Find versions from each session
    const versionsA = versions.filter((v) => v.sessionId === sessionA)
    const versionsB = versions.filter((v) => v.sessionId === sessionB)

    if (versionsA.length === 0 || versionsB.length === 0) {
      // If one session has no versions, use the first version as base
      return versions.length > 0 ? versions[0] : null
    }

    // Find the latest version that's older than both sessions' first writes
    const firstA = versionsA[0].timestamp
    const firstB = versionsB[0].timestamp
    const cutoff = Math.min(firstA, firstB)

    for (let i = versions.length - 1; i >= 0; i--) {
      if (versions[i].timestamp < cutoff) {
        return versions[i]
      }
    }

    // No common base found, return the first version
    return versions.length > 0 ? versions[0] : null
  }

  /**
   * Get version by hash
   */
  getVersionByHash(absolutePath: string, hash: string): FileVersion | null {
    const normalizedPath = this.normalizePath(absolutePath)
    const file = this.files.get(normalizedPath)
    if (!file) {
      return null
    }

    return file.versions.find((v) => v.hash === hash) ?? null
  }

  /**
   * Get the tracked file info
   */
  getTrackedFile(absolutePath: string): TrackedFile | null {
    const normalizedPath = this.normalizePath(absolutePath)
    return this.files.get(normalizedPath) ?? null
  }

  /**
   * Get all tracked files
   */
  getAllTrackedFiles(): TrackedFile[] {
    return Array.from(this.files.values())
  }

  /**
   * Get all files for a session
   */
  getFilesForSession(sessionId: string): string[] {
    return Array.from(this.sessionFiles.get(sessionId) ?? [])
  }

  /**
   * Unregister a session (cleanup when session ends)
   */
  unregisterSession(sessionId: string): void {
    const filePaths = this.sessionFiles.get(sessionId)
    if (!filePaths) {
      return
    }

    for (const filePath of filePaths) {
      const file = this.files.get(filePath)
      if (file) {
        file.readers.delete(sessionId)
        file.writers.delete(sessionId)

        // Clean up file entry if no sessions are tracking it
        if (file.readers.size === 0 && file.writers.size === 0) {
          this.files.delete(filePath)
        }
      }
    }

    this.sessionFiles.delete(sessionId)
    this.log.debug({ sessionId }, "Unregistered session")
  }

  /**
   * Remove tracking for a specific file
   */
  untrackFile(absolutePath: string): void {
    const normalizedPath = this.normalizePath(absolutePath)
    const file = this.files.get(normalizedPath)
    if (!file) {
      return
    }

    // Remove from all session mappings
    for (const [sessionId, files] of this.sessionFiles) {
      files.delete(normalizedPath)
    }

    this.files.delete(normalizedPath)
    this.log.debug({ path: normalizedPath }, "Untracked file")
  }

  /**
   * Prune old versions from all files
   */
  pruneOldVersions(maxAgeMs: number): number {
    const now = Date.now()
    let pruned = 0

    for (const file of this.files.values()) {
      const oldLength = file.versions.length
      file.versions = file.versions.filter(
        (v) => now - v.timestamp < maxAgeMs
      )
      pruned += oldLength - file.versions.length
    }

    if (pruned > 0) {
      this.log.debug({ pruned, maxAgeMs }, "Pruned old versions")
    }
    return pruned
  }

  /**
   * Clear all tracking data
   */
  clear(): void {
    this.files.clear()
    this.sessionFiles.clear()
    this.log.debug({}, "Cleared all tracking data")
  }

  /**
   * Get statistics about tracked files
   */
  getStats(): {
    trackedFiles: number
    totalVersions: number
    activeSessions: number
  } {
    let totalVersions = 0
    for (const file of this.files.values()) {
      totalVersions += file.versions.length
    }

    return {
      trackedFiles: this.files.size,
      totalVersions,
      activeSessions: this.sessionFiles.size,
    }
  }

  /**
   * Compute hash from disk (fallback when content not provided)
   */
  private computeHashFromDisk(absolutePath: string): string {
    try {
      const content = fs.readFileSync(absolutePath, "utf8")
      return this.computeHash(content)
    } catch {
      return ""
    }
  }

  /**
   * Get file stats
   */
  private getFileStats(absolutePath: string): fs.Stats | null {
    try {
      return fs.statSync(absolutePath)
    } catch {
      return null
    }
  }
}

// Singleton instance
let trackerInstance: FileChangeTracker | null = null

export function getFileChangeTracker(): FileChangeTracker {
  if (!trackerInstance) {
    trackerInstance = new FileChangeTracker()
  }
  return trackerInstance
}

export function createFileChangeTracker(
  options?: FileChangeTrackerOptions
): FileChangeTracker {
  trackerInstance = new FileChangeTracker(options)
  return trackerInstance
}
