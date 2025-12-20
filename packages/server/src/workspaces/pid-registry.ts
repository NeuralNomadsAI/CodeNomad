import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs"
import path from "path"
import os from "os"
import { Logger } from "../logger"

const PID_REGISTRY_DIR = path.join(os.homedir(), ".config", "codenomad")
const PID_REGISTRY_PATH = path.join(PID_REGISTRY_DIR, "workspace-pids.json")

interface WorkspacePidEntry {
  pid: number
  folder: string
  startedAt: string
}

interface PidRegistry {
  workspaces: Record<string, WorkspacePidEntry>
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readRegistry(): PidRegistry {
  try {
    if (!existsSync(PID_REGISTRY_PATH)) {
      return { workspaces: {} }
    }
    const content = readFileSync(PID_REGISTRY_PATH, "utf-8")
    return JSON.parse(content) as PidRegistry
  } catch {
    return { workspaces: {} }
  }
}

function writeRegistry(registry: PidRegistry): void {
  try {
    mkdirSync(PID_REGISTRY_DIR, { recursive: true })
    writeFileSync(PID_REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf-8")
  } catch (error) {
    // Silently fail - not critical
  }
}

/**
 * Register a workspace process in the PID registry
 */
export function registerWorkspacePid(workspaceId: string, pid: number, folder: string, logger?: Logger): void {
  const registry = readRegistry()
  registry.workspaces[workspaceId] = {
    pid,
    folder,
    startedAt: new Date().toISOString(),
  }
  writeRegistry(registry)
  logger?.debug({ workspaceId, pid, folder }, "Registered workspace PID")
}

/**
 * Unregister a workspace process from the PID registry
 */
export function unregisterWorkspacePid(workspaceId: string, logger?: Logger): void {
  const registry = readRegistry()
  if (registry.workspaces[workspaceId]) {
    delete registry.workspaces[workspaceId]
    writeRegistry(registry)
    logger?.debug({ workspaceId }, "Unregistered workspace PID")
  }
}

/**
 * Clean up any orphaned workspace processes from a previous crash
 * Call this on server startup before launching new workspaces
 */
export function cleanupOrphanedWorkspaces(logger?: Logger): void {
  const registry = readRegistry()
  const orphanIds: string[] = []

  for (const [workspaceId, entry] of Object.entries(registry.workspaces)) {
    if (processExists(entry.pid)) {
      logger?.info(
        { workspaceId, pid: entry.pid, folder: entry.folder, startedAt: entry.startedAt },
        "Found orphaned workspace process, killing it"
      )
      try {
        process.kill(entry.pid, "SIGTERM")
        // Give it time to die gracefully
        setTimeout(() => {
          if (processExists(entry.pid)) {
            logger?.warn({ workspaceId, pid: entry.pid }, "Orphan didn't respond to SIGTERM, sending SIGKILL")
            try {
              process.kill(entry.pid, "SIGKILL")
            } catch {
              // Process may have exited
            }
          }
        }, 1000)
      } catch (error) {
        logger?.warn({ workspaceId, pid: entry.pid, error }, "Failed to kill orphaned workspace process")
      }
    } else {
      logger?.debug({ workspaceId, pid: entry.pid }, "Orphaned workspace process no longer exists")
    }
    orphanIds.push(workspaceId)
  }

  // Clear the registry after cleanup
  if (orphanIds.length > 0) {
    registry.workspaces = {}
    writeRegistry(registry)
    logger?.info({ count: orphanIds.length }, "Cleaned up orphaned workspace registry entries")
  }
}

/**
 * Get all registered workspace PIDs (for debugging/monitoring)
 */
export function getRegisteredWorkspaces(): Record<string, WorkspacePidEntry> {
  return readRegistry().workspaces
}

/**
 * Clear the entire PID registry (for testing or manual cleanup)
 */
export function clearPidRegistry(logger?: Logger): void {
  try {
    if (existsSync(PID_REGISTRY_PATH)) {
      unlinkSync(PID_REGISTRY_PATH)
      logger?.debug("Cleared workspace PID registry")
    }
  } catch (error) {
    logger?.warn({ error }, "Failed to clear workspace PID registry")
  }
}
