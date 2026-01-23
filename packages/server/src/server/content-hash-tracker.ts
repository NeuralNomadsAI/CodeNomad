/**
 * Content Hash Tracker
 *
 * Tracks file content hashes to detect external modifications.
 * Uses SHA-256 for reliable hash computation.
 */

import { createHash } from "crypto"
import * as fs from "fs"
import { createLogger } from "../logger.js"

const log = createLogger({ component: "content-hash-tracker" })

export interface HashRecord {
  hash: string
  timestamp: number
  sessionId: string
}

export interface ConflictInfo {
  hasConflict: boolean
  currentHash: string | null
  expectedHash: string
  lastModifiedBy: string | null
  lastModifiedAt: number | null
}

/**
 * Content Hash Tracker
 *
 * Tracks file content hashes to detect when files have been modified
 * externally or by another session. This enables optimistic locking
 * by comparing expected vs actual hashes before writes.
 */
class ContentHashTracker {
  private hashes = new Map<string, HashRecord>()
  private static instance: ContentHashTracker

  static getInstance(): ContentHashTracker {
    if (!ContentHashTracker.instance) {
      ContentHashTracker.instance = new ContentHashTracker()
    }
    return ContentHashTracker.instance
  }

  /**
   * Normalize file path for consistent hash keys
   */
  private normalizePath(path: string): string {
    return path.replace(/\\/g, "/").toLowerCase()
  }

  /**
   * Compute SHA-256 hash of content, truncated to 16 hex chars
   * 16 hex chars = 64 bits, which is more than enough for collision resistance
   * in this use case (detecting same-file modifications)
   */
  computeHash(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16)
  }

  /**
   * Record the hash of a file's content
   * Called after reading or writing a file
   *
   * @param path - The file path
   * @param content - The file content
   * @param sessionId - The session that read/wrote the file
   */
  recordHash(path: string, content: string, sessionId: string): void {
    const normalizedPath = this.normalizePath(path)
    const hash = this.computeHash(content)

    this.hashes.set(normalizedPath, {
      hash,
      timestamp: Date.now(),
      sessionId,
    })

    log.debug({ path: normalizedPath, hash, sessionId }, "Recorded content hash")
  }

  /**
   * Get the recorded hash for a file
   */
  getCurrentHash(path: string): string | null {
    const normalizedPath = this.normalizePath(path)
    return this.hashes.get(normalizedPath)?.hash ?? null
  }

  /**
   * Get full hash record for a file
   */
  getHashRecord(path: string): HashRecord | null {
    const normalizedPath = this.normalizePath(path)
    return this.hashes.get(normalizedPath) ?? null
  }

  /**
   * Verify that a file's content matches the expected hash
   */
  verifyHash(path: string, expectedHash: string): boolean {
    const normalizedPath = this.normalizePath(path)
    const record = this.hashes.get(normalizedPath)

    if (!record) {
      // No recorded hash, read from disk
      try {
        const content = fs.readFileSync(path, "utf-8")
        const diskHash = this.computeHash(content)
        return diskHash === expectedHash
      } catch {
        // File doesn't exist or can't be read
        return false
      }
    }

    return record.hash === expectedHash
  }

  /**
   * Detect if there's a conflict between expected and actual content
   * This is the primary method for optimistic locking
   *
   * @param path - The file path
   * @param expectedHash - The hash the client expects (from their last read)
   * @returns ConflictInfo with details about any detected conflict
   */
  detectConflict(path: string, expectedHash: string): ConflictInfo {
    const normalizedPath = this.normalizePath(path)
    const record = this.hashes.get(normalizedPath)

    // If no record exists, check disk
    if (!record) {
      try {
        const content = fs.readFileSync(path, "utf-8")
        const diskHash = this.computeHash(content)

        // Record this hash for future comparisons
        this.hashes.set(normalizedPath, {
          hash: diskHash,
          timestamp: Date.now(),
          sessionId: "disk-read",
        })

        return {
          hasConflict: diskHash !== expectedHash,
          currentHash: diskHash,
          expectedHash,
          lastModifiedBy: null,
          lastModifiedAt: null,
        }
      } catch {
        // File doesn't exist, no conflict
        return {
          hasConflict: false,
          currentHash: null,
          expectedHash,
          lastModifiedBy: null,
          lastModifiedAt: null,
        }
      }
    }

    const hasConflict = record.hash !== expectedHash

    if (hasConflict) {
      log.debug(
        {
          path: normalizedPath,
          expectedHash,
          currentHash: record.hash,
          lastModifiedBy: record.sessionId,
        },
        "Conflict detected"
      )
    }

    return {
      hasConflict,
      currentHash: record.hash,
      expectedHash,
      lastModifiedBy: record.sessionId,
      lastModifiedAt: record.timestamp,
    }
  }

  /**
   * Invalidate the cached hash for a file
   * Call this when a file is deleted or when you want to force a re-read
   */
  invalidate(path: string): void {
    const normalizedPath = this.normalizePath(path)
    this.hashes.delete(normalizedPath)
    log.debug({ path: normalizedPath }, "Invalidated hash")
  }

  /**
   * Clear all cached hashes
   * Useful for testing or when doing bulk operations
   */
  clearAll(): void {
    this.hashes.clear()
    log.debug({}, "Cleared all hashes")
  }

  /**
   * Get all tracked files (for debugging/monitoring)
   */
  getTrackedFiles(): string[] {
    return Array.from(this.hashes.keys())
  }

  /**
   * Get hash statistics
   */
  getStats(): { trackedFiles: number; oldestEntry: number | null } {
    let oldest: number | null = null

    for (const record of this.hashes.values()) {
      if (oldest === null || record.timestamp < oldest) {
        oldest = record.timestamp
      }
    }

    return {
      trackedFiles: this.hashes.size,
      oldestEntry: oldest,
    }
  }

  /**
   * Clean up old hash entries
   * Removes entries older than maxAgeMs
   */
  cleanupOldEntries(maxAgeMs: number): number {
    const now = Date.now()
    let removed = 0

    for (const [path, record] of this.hashes) {
      if (now - record.timestamp > maxAgeMs) {
        this.hashes.delete(path)
        removed++
      }
    }

    if (removed > 0) {
      log.debug({ removed, maxAgeMs }, "Cleaned up old hash entries")
    }

    return removed
  }
}

// Export singleton instance
export const contentHashTracker = ContentHashTracker.getInstance()

// Export class for testing
export { ContentHashTracker }
