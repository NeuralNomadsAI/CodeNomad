/**
 * File Lock Manager
 *
 * Provides mutex-based file locking to prevent concurrent modifications.
 * Uses async-mutex for reliable async locking with timeout support.
 */

import { Mutex, MutexInterface } from "async-mutex"
import { createLogger } from "../logger.js"

const log = createLogger({ component: "file-lock-manager" })

interface LockInfo {
  sessionId: string
  timestamp: number
  mutex: Mutex
  releaser: MutexInterface.Releaser | null
}

export interface AcquiredLock {
  path: string
  sessionId: string
  acquiredAt: number
  release: () => void
}

export interface LockStatus {
  path: string
  isLocked: boolean
  holder: string | null
  heldSince: number | null
}

/**
 * Centralized file lock manager that serializes writes to the same file path.
 * Singleton pattern ensures all routes use the same lock state.
 */
class FileLockManager {
  private locks = new Map<string, LockInfo>()
  private static instance: FileLockManager

  static getInstance(): FileLockManager {
    if (!FileLockManager.instance) {
      FileLockManager.instance = new FileLockManager()
    }
    return FileLockManager.instance
  }

  /**
   * Normalize file path for consistent lock keys
   */
  private normalizePath(path: string): string {
    return path.replace(/\\/g, "/").toLowerCase()
  }

  /**
   * Get or create lock info for a path
   */
  private getLockInfo(path: string): LockInfo {
    const normalizedPath = this.normalizePath(path)

    if (!this.locks.has(normalizedPath)) {
      this.locks.set(normalizedPath, {
        sessionId: "",
        timestamp: 0,
        mutex: new Mutex(),
        releaser: null,
      })
    }

    return this.locks.get(normalizedPath)!
  }

  /**
   * Acquire a lock for the given file path.
   * Blocks until the lock is available or timeout is reached.
   *
   * @param path - The file path to lock
   * @param sessionId - The session acquiring the lock
   * @param timeoutMs - Maximum time to wait for lock (default: 5000ms)
   * @returns AcquiredLock object with release function
   * @throws Error if timeout is reached
   */
  async acquireLock(
    path: string,
    sessionId: string,
    timeoutMs = 5000
  ): Promise<AcquiredLock> {
    const normalizedPath = this.normalizePath(path)
    const lockInfo = this.getLockInfo(normalizedPath)

    log.debug({ path: normalizedPath, sessionId, timeoutMs }, "Attempting to acquire lock")

    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        const holder = lockInfo.sessionId || "unknown"
        reject(
          new Error(
            `Lock timeout for ${path} after ${timeoutMs}ms. Currently held by: ${holder}`
          )
        )
      }, timeoutMs)
    })

    // Race between acquiring lock and timeout
    const releaser = await Promise.race([
      lockInfo.mutex.acquire(),
      timeoutPromise,
    ])

    // Update lock info
    const acquiredAt = Date.now()
    lockInfo.sessionId = sessionId
    lockInfo.timestamp = acquiredAt
    lockInfo.releaser = releaser

    log.debug({ path: normalizedPath, sessionId, acquiredAt }, "Lock acquired")

    // Return lock handle with release function
    return {
      path: normalizedPath,
      sessionId,
      acquiredAt,
      release: () => {
        this.releaseLock(normalizedPath, sessionId)
      },
    }
  }

  /**
   * Release a lock for the given file path.
   * Only the session that acquired the lock can release it.
   *
   * @param path - The file path to unlock
   * @param sessionId - The session releasing the lock
   */
  releaseLock(path: string, sessionId: string): void {
    const normalizedPath = this.normalizePath(path)
    const lockInfo = this.locks.get(normalizedPath)

    if (!lockInfo) {
      log.warn({ path: normalizedPath, sessionId }, "Attempted to release non-existent lock")
      return
    }

    if (lockInfo.sessionId !== sessionId) {
      log.warn(
        { path: normalizedPath, requestedBy: sessionId, heldBy: lockInfo.sessionId },
        "Attempted to release lock held by different session"
      )
      return
    }

    if (lockInfo.releaser) {
      lockInfo.releaser()
      lockInfo.releaser = null
    }

    lockInfo.sessionId = ""
    lockInfo.timestamp = 0

    log.debug({ path: normalizedPath, sessionId }, "Lock released")
  }

  /**
   * Check if a file is currently locked
   */
  isLocked(path: string): boolean {
    const normalizedPath = this.normalizePath(path)
    const lockInfo = this.locks.get(normalizedPath)
    return lockInfo?.mutex.isLocked() ?? false
  }

  /**
   * Get the session ID of the lock holder
   */
  getLockHolder(path: string): string | null {
    const normalizedPath = this.normalizePath(path)
    const lockInfo = this.locks.get(normalizedPath)

    if (lockInfo?.mutex.isLocked() && lockInfo.sessionId) {
      return lockInfo.sessionId
    }

    return null
  }

  /**
   * Get full lock status for a file
   */
  getLockStatus(path: string): LockStatus {
    const normalizedPath = this.normalizePath(path)
    const lockInfo = this.locks.get(normalizedPath)
    const isLocked = lockInfo?.mutex.isLocked() ?? false

    return {
      path: normalizedPath,
      isLocked,
      holder: isLocked ? lockInfo?.sessionId ?? null : null,
      heldSince: isLocked ? lockInfo?.timestamp ?? null : null,
    }
  }

  /**
   * Get all current locks (for debugging/monitoring)
   */
  getAllLocks(): LockStatus[] {
    const statuses: LockStatus[] = []

    for (const [path] of this.locks) {
      statuses.push(this.getLockStatus(path))
    }

    return statuses.filter((s) => s.isLocked)
  }

  /**
   * Force release a lock (admin operation)
   * Use with caution - only for cleanup/recovery
   */
  forceRelease(path: string): boolean {
    const normalizedPath = this.normalizePath(path)
    const lockInfo = this.locks.get(normalizedPath)

    if (!lockInfo) {
      return false
    }

    if (lockInfo.releaser) {
      lockInfo.releaser()
      lockInfo.releaser = null
    }

    const previousHolder = lockInfo.sessionId
    lockInfo.sessionId = ""
    lockInfo.timestamp = 0

    log.warn({ path: normalizedPath, previousHolder }, "Lock force released")

    return true
  }

  /**
   * Clear stale locks older than the specified age
   * Useful for cleanup after crashes
   */
  clearStaleLocks(maxAgeMs: number): number {
    const now = Date.now()
    let cleared = 0

    for (const [path, lockInfo] of this.locks) {
      if (
        lockInfo.mutex.isLocked() &&
        lockInfo.timestamp &&
        now - lockInfo.timestamp > maxAgeMs
      ) {
        log.warn(
          { path, heldBy: lockInfo.sessionId, age: now - lockInfo.timestamp },
          "Clearing stale lock"
        )

        if (lockInfo.releaser) {
          lockInfo.releaser()
          lockInfo.releaser = null
        }

        lockInfo.sessionId = ""
        lockInfo.timestamp = 0
        cleared++
      }
    }

    return cleared
  }
}

// Export singleton instance
export const fileLockManager = FileLockManager.getInstance()

// Export class for testing
export { FileLockManager }
