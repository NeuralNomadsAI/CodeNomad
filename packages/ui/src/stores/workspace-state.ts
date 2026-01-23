import { createSignal } from "solid-js"

export interface GitStatus {
  branch?: string
  ahead?: number
  behind?: number
  staged?: number
  unstaged?: number
  untracked?: number
}

export type FileOperationType = "read" | "write" | "edit" | "create" | "delete"

export interface FileOperation {
  path: string
  operation: FileOperationType
  timestamp: number
}

export interface RecentAction {
  id: string
  type: "tool_call" | "file_change" | "git_operation"
  description: string
  status: "running" | "success" | "error"
  timestamp: number
}

const [gitStatusByInstance, setGitStatusByInstance] = createSignal<Map<string, GitStatus>>(new Map())
const [filesTouchedByInstance, setFilesTouchedByInstance] = createSignal<Map<string, FileOperation[]>>(new Map())
const [recentActionsByInstance, setRecentActionsByInstance] = createSignal<Map<string, RecentAction[]>>(new Map())

export function getGitStatus(instanceId: string): GitStatus | undefined {
  return gitStatusByInstance().get(instanceId)
}

export function setGitStatus(instanceId: string, status: GitStatus): void {
  setGitStatusByInstance((prev) => {
    const next = new Map(prev)
    next.set(instanceId, status)
    return next
  })
}

export function clearGitStatus(instanceId: string): void {
  setGitStatusByInstance((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
}

// Alias for backward compatibility
export const updateGitStatus = setGitStatus

export function getFilesTouched(instanceId: string): FileOperation[] {
  return filesTouchedByInstance().get(instanceId) ?? []
}

export function addFileTouched(instanceId: string, operation: FileOperation): void {
  setFilesTouchedByInstance((prev) => {
    const next = new Map(prev)
    const existing = next.get(instanceId) ?? []
    next.set(instanceId, [...existing, operation].slice(-50)) // Keep last 50
    return next
  })
}

export function getRecentActions(instanceId: string): RecentAction[] {
  return recentActionsByInstance().get(instanceId) ?? []
}

export function addRecentAction(instanceId: string, action: RecentAction): void {
  setRecentActionsByInstance((prev) => {
    const next = new Map(prev)
    const existing = next.get(instanceId) ?? []
    next.set(instanceId, [...existing, action].slice(-20)) // Keep last 20
    return next
  })
}

export function clearWorkspaceState(instanceId: string): void {
  clearGitStatus(instanceId)
  setFilesTouchedByInstance((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
  setRecentActionsByInstance((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
}

/**
 * Process tool calls to extract workspace-relevant information.
 * Currently a stub - can be expanded to track file changes, git operations, etc.
 */
export function processToolCallForWorkspace(
  _instanceId: string,
  _partId: string,
  _toolName: string,
  _input: Record<string, unknown>,
  _status: string
): void {
  // Stub for future workspace state tracking
  // Could be used to:
  // - Track which files are being modified
  // - Update git status after git operations
  // - Monitor file conflict potential
}
