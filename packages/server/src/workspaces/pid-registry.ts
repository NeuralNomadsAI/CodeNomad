import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs"
import { execSync } from "child_process"
import path from "path"
import os from "os"
import { Logger } from "../logger"

/**
 * Kill a process and all its children (process tree)
 */
function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM", logger?: Logger): void {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" })
    } else {
      // Kill children first
      try {
        const children = execSync(`pgrep -P ${pid}`, { encoding: "utf-8" }).trim().split("\n").filter(Boolean)
        for (const childPid of children) {
          const childPidNum = parseInt(childPid, 10)
          if (!isNaN(childPidNum)) {
            try {
              process.kill(childPidNum, signal)
            } catch {
              // Child may have already exited
            }
          }
        }
      } catch {
        // No children or pgrep failed
      }
      process.kill(pid, signal)
    }
  } catch {
    // Process may have already exited
  }
}

const PID_REGISTRY_DIR = path.join(os.homedir(), ".config", "era-code")
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
        "Found orphaned workspace process tree, killing it"
      )
      // Kill the entire process tree (parent + children)
      killProcessTree(entry.pid, "SIGTERM", logger)
      // Give it time to die gracefully, then force kill if needed
      setTimeout(() => {
        if (processExists(entry.pid)) {
          logger?.warn({ workspaceId, pid: entry.pid }, "Orphan process tree didn't respond to SIGTERM, sending SIGKILL")
          killProcessTree(entry.pid, "SIGKILL", logger)
        }
      }, 1000)
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
