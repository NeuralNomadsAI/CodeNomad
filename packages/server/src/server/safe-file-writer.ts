/**
 * Safe File Writer
 *
 * Provides safe file read/write operations with:
 * - Mutex-based locking to prevent concurrent writes
 * - Content hash tracking for optimistic locking
 * - Configurable conflict resolution strategies
 */

import * as fs from "fs"
import * as path from "path"
import { fileLockManager } from "./file-lock-manager.js"
import { contentHashTracker, ConflictInfo } from "./content-hash-tracker.js"
import { createLogger } from "../logger.js"

const log = createLogger({ component: "safe-file-writer" })

/**
 * Conflict resolution strategies:
 * - fail-fast: Reject write if content has changed (default)
 * - queue: Serialize writes, apply in order (lock handles this)
 * - last-write-wins: Accept latest write regardless of conflicts
 */
export type ConflictResolution = "fail-fast" | "queue" | "last-write-wins"

export interface WriteOptions {
  /** The session performing the write */
  sessionId: string
  /** Expected content hash (from last read) for conflict detection */
  expectedHash?: string
  /** How to handle conflicts (default: fail-fast) */
  resolution?: ConflictResolution
  /** Lock acquisition timeout in ms (default: 5000) */
  timeoutMs?: number
  /** Create parent directories if they don't exist (default: true) */
  createDirs?: boolean
}

export interface WriteResult {
  success: boolean
  /** New content hash after successful write */
  newHash: string
  /** Error message if write failed */
  error?: string
  /** Conflict details if write was rejected due to conflict */
  conflictInfo?: {
    currentHash: string
    lastModifiedBy: string | null
    lastModifiedAt: number | null
  }
}

export interface ReadOptions {
  /** The session performing the read */
  sessionId: string
}

export interface ReadResult {
  success: boolean
  content: string
  hash: string
  error?: string
}

/**
 * Safely write a file with locking and conflict detection
 *
 * @param filePath - The file path to write
 * @param content - The content to write
 * @param options - Write options including session ID and conflict resolution
 * @returns WriteResult with success status, new hash, or error/conflict info
 */
export async function safeWriteFile(
  filePath: string,
  content: string,
  options: WriteOptions
): Promise<WriteResult> {
  const {
    sessionId,
    expectedHash,
    resolution = "fail-fast",
    timeoutMs = 5000,
    createDirs = true,
  } = options

  log.debug({ filePath, sessionId, resolution, hasExpectedHash: !!expectedHash }, "Safe write requested")

  let lock
  try {
    // Acquire lock
    lock = await fileLockManager.acquireLock(filePath, sessionId, timeoutMs)

    // Check for conflicts if expectedHash provided
    if (expectedHash && resolution === "fail-fast") {
      const conflict = contentHashTracker.detectConflict(filePath, expectedHash)

      if (conflict.hasConflict) {
        log.info(
          {
            filePath,
            sessionId,
            expectedHash,
            currentHash: conflict.currentHash,
            lastModifiedBy: conflict.lastModifiedBy,
          },
          "Write rejected due to conflict"
        )

        return {
          success: false,
          newHash: conflict.currentHash || "",
          error: "File was modified by another session",
          conflictInfo: {
            currentHash: conflict.currentHash || "",
            lastModifiedBy: conflict.lastModifiedBy,
            lastModifiedAt: conflict.lastModifiedAt,
          },
        }
      }
    }

    // Ensure directory exists
    if (createDirs) {
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
        log.debug({ dir }, "Created parent directories")
      }
    }

    // Write file
    fs.writeFileSync(filePath, content, "utf-8")

    // Record new hash
    const newHash = contentHashTracker.computeHash(content)
    contentHashTracker.recordHash(filePath, content, sessionId)

    log.debug({ filePath, sessionId, newHash }, "File written successfully")

    return {
      success: true,
      newHash,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    log.error({ filePath, sessionId, error: message }, "Safe write failed")

    return {
      success: false,
      newHash: "",
      error: message,
    }
  } finally {
    lock?.release()
  }
}

/**
 * Safely read a file and record its hash for future conflict detection
 *
 * @param filePath - The file path to read
 * @param options - Read options including session ID
 * @returns ReadResult with content, hash, or error
 */
export async function safeReadFile(
  filePath: string,
  options: ReadOptions
): Promise<ReadResult> {
  const { sessionId } = options

  log.debug({ filePath, sessionId }, "Safe read requested")

  try {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        content: "",
        hash: "",
        error: "File not found",
      }
    }

    // Read file
    const content = fs.readFileSync(filePath, "utf-8")

    // Compute and record hash
    const hash = contentHashTracker.computeHash(content)
    contentHashTracker.recordHash(filePath, content, sessionId)

    log.debug({ filePath, sessionId, hash }, "File read successfully")

    return {
      success: true,
      content,
      hash,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    log.error({ filePath, sessionId, error: message }, "Safe read failed")

    return {
      success: false,
      content: "",
      hash: "",
      error: message,
    }
  }
}

/**
 * Safely delete a file with locking
 *
 * @param filePath - The file path to delete
 * @param sessionId - The session performing the delete
 * @returns Success status
 */
export async function safeDeleteFile(
  filePath: string,
  sessionId: string
): Promise<{ success: boolean; error?: string }> {
  log.debug({ filePath, sessionId }, "Safe delete requested")

  let lock
  try {
    // Acquire lock
    lock = await fileLockManager.acquireLock(filePath, sessionId, 5000)

    // Delete file if it exists
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      contentHashTracker.invalidate(filePath)
      log.debug({ filePath, sessionId }, "File deleted successfully")
    }

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    log.error({ filePath, sessionId, error: message }, "Safe delete failed")

    return { success: false, error: message }
  } finally {
    lock?.release()
  }
}

/**
 * Check if a file has been modified since a given hash
 *
 * @param filePath - The file path to check
 * @param expectedHash - The hash to compare against
 * @returns ConflictInfo with details about any modification
 */
export function checkFileModified(filePath: string, expectedHash: string): ConflictInfo {
  return contentHashTracker.detectConflict(filePath, expectedHash)
}

/**
 * Get the current hash for a file without reading it
 * Returns null if file is not tracked
 */
export function getFileHash(filePath: string): string | null {
  return contentHashTracker.getCurrentHash(filePath)
}

/**
 * Force refresh the hash for a file by reading from disk
 */
export async function refreshFileHash(
  filePath: string,
  sessionId: string
): Promise<string | null> {
  const result = await safeReadFile(filePath, { sessionId })
  return result.success ? result.hash : null
}

/**
 * Get lock status for a file
 */
export function getFileLockStatus(filePath: string) {
  return fileLockManager.getLockStatus(filePath)
}

/**
 * Export utilities for direct access when needed
 */
export { fileLockManager, contentHashTracker }
