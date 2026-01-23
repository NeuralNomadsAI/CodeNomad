/**
 * File Conflicts Store
 *
 * Manages file conflict state in the UI, handling SSE events for
 * file changes and conflicts, and providing actions for resolution.
 */

import { createSignal, createMemo, batch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type {
  FileChangedEvent,
  FileConflictEvent,
  FileConflictResolvedEvent,
  FileConflictRegion,
  FileSessionInfo,
  FileConflictType,
} from "../../../server/src/api-types"
import { getLogger } from "../lib/logger"
import { showToastNotification } from "../lib/notifications"

const log = getLogger("file-conflicts")

// Re-export types for convenience
export type {
  FileChangedEvent,
  FileConflictEvent,
  FileConflictResolvedEvent,
  FileConflictRegion,
  FileSessionInfo,
  FileConflictType,
}

// API response types
interface TrackedFileInfo {
  path: string
  hash: string
  isBinary: boolean
  size: number
  sessions: Array<{
    sessionId: string
    mode: "read" | "write"
  }>
  hasConflict: boolean
  lastModified: number
}

interface ConflictDetailResponse {
  conflictId: string
  filePath: string
  absolutePath: string
  conflictType: FileConflictType
  involvedSessions: FileSessionInfo[]
  mergeResult: {
    canAutoMerge: boolean
    mergedContent?: string
    conflicts?: FileConflictRegion[]
  }
  timestamp: number
  isBinary: boolean
  diff: {
    base: string
    ours: string
    theirs: string
    merged?: string
  }
}

interface FileHistoryVersion {
  hash: string
  timestamp: number
  sessionId: string
  instanceId: string
  hasContent: boolean
}

interface FileConflictState {
  // Active conflicts keyed by conflictId
  activeConflicts: Map<string, FileConflictEvent>
  // Recent file changes (circular buffer)
  recentChanges: FileChangedEvent[]
  // Resolved conflicts for reference
  resolvedConflicts: FileConflictResolvedEvent[]
  // Currently selected conflict for resolution
  selectedConflictId: string | null
  // Loading states
  loading: boolean
  loadingConflict: string | null
}

const MAX_RECENT_CHANGES = 50
const MAX_RESOLVED_CONFLICTS = 20

// Create reactive state
const [state, setState] = createStore<FileConflictState>({
  activeConflicts: new Map(),
  recentChanges: [],
  resolvedConflicts: [],
  selectedConflictId: null,
  loading: false,
  loadingConflict: null,
})

// API base URL
const getApiBase = () => {
  return typeof window !== "undefined"
    ? window.__ERA_CODE_API_BASE__ ?? window.location.origin
    : "http://127.0.0.1:9898"
}

// Derived state
export const activeConflicts = createMemo(() => Array.from(state.activeConflicts.values()))
export const activeConflictCount = createMemo(() => state.activeConflicts.size)
export const hasConflicts = createMemo(() => state.activeConflicts.size > 0)
export const recentChanges = () => state.recentChanges
export const resolvedConflicts = () => state.resolvedConflicts
export const selectedConflictId = () => state.selectedConflictId
export const isLoading = () => state.loading
export const loadingConflictId = () => state.loadingConflict

// Get conflicts for a specific session
export const getConflictsForSession = (sessionId: string): FileConflictEvent[] => {
  return activeConflicts().filter((c) =>
    c.involvedSessions.some((s) => s.sessionId === sessionId)
  )
}

// Get a specific conflict
export const getConflict = (conflictId: string): FileConflictEvent | undefined => {
  return state.activeConflicts.get(conflictId)
}

// Handle file changed event from SSE
export function handleFileChanged(event: FileChangedEvent): void {
  log.info("File changed", { path: event.filePath, type: event.changeType })

  setState(
    produce((s) => {
      // Add to recent changes (circular buffer)
      s.recentChanges.push(event)
      if (s.recentChanges.length > MAX_RECENT_CHANGES) {
        s.recentChanges.shift()
      }
    })
  )

  // Show toast for external changes affecting current session
  if (event.sessionId === "external" && event.affectedSessions.length > 0) {
    showToastNotification({
      title: "File Changed Externally",
      message: `${event.filePath} was modified outside Era Code`,
      variant: "warning",
      duration: 5000,
    })
  }
}

// Handle file conflict event from SSE
export function handleFileConflict(event: FileConflictEvent): void {
  log.warn("File conflict detected", {
    conflictId: event.conflictId,
    path: event.filePath,
    type: event.conflictType,
  })

  setState(
    produce((s) => {
      s.activeConflicts.set(event.conflictId, event)
    })
  )

  // Show notification
  const canAutoMerge = event.mergeResult.canAutoMerge
  showToastNotification({
    title: "File Conflict Detected",
    message: canAutoMerge
      ? `${event.filePath} can be auto-merged`
      : `${event.filePath} requires manual resolution`,
    variant: canAutoMerge ? "warning" : "error",
    duration: 10000,
  })
}

// Handle file conflict resolved event from SSE
export function handleFileConflictResolved(event: FileConflictResolvedEvent): void {
  log.info("File conflict resolved", {
    conflictId: event.conflictId,
    resolution: event.resolution,
  })

  setState(
    produce((s) => {
      // Remove from active conflicts
      s.activeConflicts.delete(event.conflictId)

      // Add to resolved (circular buffer)
      s.resolvedConflicts.push(event)
      if (s.resolvedConflicts.length > MAX_RESOLVED_CONFLICTS) {
        s.resolvedConflicts.shift()
      }

      // Clear selection if this was the selected conflict
      if (s.selectedConflictId === event.conflictId) {
        s.selectedConflictId = null
      }
    })
  )

  showToastNotification({
    title: "Conflict Resolved",
    message: `${event.filePath} - ${event.resolution}`,
    variant: "success",
    duration: 5000,
  })
}

// Select a conflict for resolution
export function selectConflict(conflictId: string | null): void {
  setState("selectedConflictId", conflictId)
}

// Fetch conflict details from API
export async function fetchConflictDetails(
  conflictId: string,
  workspaceRoot: string
): Promise<ConflictDetailResponse | null> {
  setState("loadingConflict", conflictId)

  try {
    const params = new URLSearchParams({ workspaceRoot })
    const response = await fetch(
      `${getApiBase()}/api/files/conflicts/${conflictId}?${params}`,
      {
        headers: { "Content-Type": "application/json" },
      }
    )

    if (!response.ok) {
      throw new Error(`Failed to fetch conflict: ${response.statusText}`)
    }

    const data = await response.json()
    return data.conflict
  } catch (error) {
    log.error("Failed to fetch conflict details", { conflictId, error })
    return null
  } finally {
    setState("loadingConflict", null)
  }
}

// Resolve a conflict via API
export async function resolveConflict(
  conflictId: string,
  resolution: "auto-merged" | "keep-ours" | "keep-theirs" | "manual",
  sessionId: string,
  workspaceRoot: string,
  content?: string
): Promise<{ success: boolean; newHash?: string; error?: string }> {
  setState("loading", true)

  try {
    const response = await fetch(
      `${getApiBase()}/api/files/conflicts/${conflictId}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resolution,
          sessionId,
          workspaceRoot,
          content,
        }),
      }
    )

    const data = await response.json()

    if (!response.ok) {
      return { success: false, error: data.error || response.statusText }
    }

    return { success: true, newHash: data.newHash }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    log.error("Failed to resolve conflict", { conflictId, error })
    return { success: false, error: message }
  } finally {
    setState("loading", false)
  }
}

// Fetch all active conflicts from API
export async function fetchActiveConflicts(
  workspaceRoot: string
): Promise<FileConflictEvent[]> {
  setState("loading", true)

  try {
    const params = new URLSearchParams({ workspaceRoot })
    const response = await fetch(
      `${getApiBase()}/api/files/conflicts?${params}`,
      {
        headers: { "Content-Type": "application/json" },
      }
    )

    if (!response.ok) {
      throw new Error(`Failed to fetch conflicts: ${response.statusText}`)
    }

    const data = await response.json()
    const conflicts = data.conflicts as FileConflictEvent[]

    // Update store with fetched conflicts
    setState(
      produce((s) => {
        s.activeConflicts.clear()
        for (const conflict of conflicts) {
          s.activeConflicts.set(conflict.conflictId, conflict)
        }
      })
    )

    return conflicts
  } catch (error) {
    log.error("Failed to fetch active conflicts", { error })
    return []
  } finally {
    setState("loading", false)
  }
}

// Fetch tracked files from API
export async function fetchTrackedFiles(
  workspaceRoot: string
): Promise<TrackedFileInfo[]> {
  try {
    const params = new URLSearchParams({ workspaceRoot })
    const response = await fetch(
      `${getApiBase()}/api/files/tracked?${params}`,
      {
        headers: { "Content-Type": "application/json" },
      }
    )

    if (!response.ok) {
      throw new Error(`Failed to fetch tracked files: ${response.statusText}`)
    }

    const data = await response.json()
    return data.files
  } catch (error) {
    log.error("Failed to fetch tracked files", { error })
    return []
  }
}

// Fetch file history from API
export async function fetchFileHistory(
  filePath: string,
  workspaceRoot: string
): Promise<FileHistoryVersion[]> {
  try {
    const params = new URLSearchParams({ path: filePath, workspaceRoot })
    const response = await fetch(
      `${getApiBase()}/api/files/history?${params}`,
      {
        headers: { "Content-Type": "application/json" },
      }
    )

    if (!response.ok) {
      throw new Error(`Failed to fetch file history: ${response.statusText}`)
    }

    const data = await response.json()
    return data.versions
  } catch (error) {
    log.error("Failed to fetch file history", { error })
    return []
  }
}

// Preview a merge without applying it
export async function previewMerge(
  base: string,
  ours: string,
  theirs: string,
  filePath?: string
): Promise<{
  success: boolean
  merged: string | null
  hasConflicts: boolean
  conflicts: FileConflictRegion[]
} | null> {
  try {
    const response = await fetch(`${getApiBase()}/api/files/merge-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base, ours, theirs, filePath }),
    })

    if (!response.ok) {
      throw new Error(`Failed to preview merge: ${response.statusText}`)
    }

    return await response.json()
  } catch (error) {
    log.error("Failed to preview merge", { error })
    return null
  }
}

// Register a file read/write with the conflict detector
export async function registerFileOperation(
  path: string,
  sessionId: string,
  instanceId: string,
  mode: "read" | "write",
  workspaceRoot: string,
  content?: string,
  hash?: string
): Promise<{ success: boolean; hash?: string; conflict?: { conflictId: string } }> {
  try {
    const response = await fetch(`${getApiBase()}/api/files/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path,
        sessionId,
        instanceId,
        mode,
        workspaceRoot,
        content,
        hash,
      }),
    })

    const data = await response.json()

    if (response.status === 409) {
      // Conflict detected
      return { success: false, conflict: data.conflict }
    }

    if (!response.ok) {
      throw new Error(data.error || response.statusText)
    }

    return { success: true, hash: data.hash }
  } catch (error) {
    log.error("Failed to register file operation", { error })
    return { success: false }
  }
}

// Unregister a session from file tracking
export async function unregisterSession(
  sessionId: string,
  workspaceRoot: string
): Promise<boolean> {
  try {
    const response = await fetch(`${getApiBase()}/api/files/unregister-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, workspaceRoot }),
    })

    return response.ok
  } catch (error) {
    log.error("Failed to unregister session", { error })
    return false
  }
}

// Fetch file conflict stats
export async function fetchFileStats(workspaceRoot: string): Promise<{
  trackedFiles: number
  totalVersions: number
  activeSessions: number
  activeConflicts: number
  watcherRunning: boolean
} | null> {
  try {
    const params = new URLSearchParams({ workspaceRoot })
    const response = await fetch(`${getApiBase()}/api/files/stats?${params}`, {
      headers: { "Content-Type": "application/json" },
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch stats: ${response.statusText}`)
    }

    return await response.json()
  } catch (error) {
    log.error("Failed to fetch file stats", { error })
    return null
  }
}

// Clear all state (for cleanup/reset)
export function clearFileConflictState(): void {
  batch(() => {
    setState("activeConflicts", new Map())
    setState("recentChanges", [])
    setState("resolvedConflicts", [])
    setState("selectedConflictId", null)
    setState("loading", false)
    setState("loadingConflict", null)
  })
}
