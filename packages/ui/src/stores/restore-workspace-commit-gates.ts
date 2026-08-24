import type { WorkspaceDescriptor } from "../../../server/src/api-types"
import { normalizeWorkspacePath } from "./app-session-reconciliation"

export interface RestoreWorkspaceTerminal {
  status: "error" | "stopped"
  message?: string
}

export interface RestoreWorkspaceCommitGate<T extends WorkspaceDescriptor> {
  requestId: string
  wait: Promise<void>
  workspace?: T
  terminal?: RestoreWorkspaceTerminal
  workspaceIds: Set<string>
  expectedPath?: string
}

const statusRank = (status: WorkspaceDescriptor["status"]) =>
  status === "error" || status === "stopped" ? 3 : status === "ready" ? 2 : 1

export function preferAdvancedWorkspaceDescriptor<T extends WorkspaceDescriptor>(current: T, candidate: T): T {
  const rankDifference = statusRank(candidate.status) - statusRank(current.status)
  if (rankDifference !== 0) return rankDifference > 0 ? candidate : current
  const currentUpdatedAt = Date.parse(current.updatedAt)
  const candidateUpdatedAt = Date.parse(candidate.updatedAt)
  if (Number.isFinite(currentUpdatedAt) && Number.isFinite(candidateUpdatedAt) && currentUpdatedAt !== candidateUpdatedAt) {
    return candidateUpdatedAt > currentUpdatedAt ? candidate : current
  }
  return candidate
}

export class RestoreWorkspaceCommitGates<T extends WorkspaceDescriptor> {
  private readonly byRequestId = new Map<string, RestoreWorkspaceCommitGate<T>>()
  private readonly byWorkspaceId = new Map<string, RestoreWorkspaceCommitGate<T>>()
  private readonly stoppedByWorkspaceId = new Map<string, RestoreWorkspaceTerminal>()

  begin(requestId: string, wait: Promise<void>, expectedPath?: string): RestoreWorkspaceCommitGate<T> {
    const gate = {
      requestId, wait, workspaceIds: new Set<string>(),
      ...(expectedPath ? { expectedPath: normalizeWorkspacePath(expectedPath) } : {}),
    }
    this.byRequestId.set(requestId, gate)
    return gate
  }

  bindResponse(requestId: string, workspaceId: string): void {
    const gate = this.byRequestId.get(requestId)
    if (!gate) return
    gate.workspaceIds.add(workspaceId)
    this.byWorkspaceId.set(workspaceId, gate)
    const stopped = this.stoppedByWorkspaceId.get(workspaceId)
    if (stopped) {
      gate.terminal = stopped
      this.stoppedByWorkspaceId.delete(workspaceId)
    }
  }

  deferWorkspace(workspace: T): boolean {
    const gate = workspace.requestId
      ? this.byRequestId.get(workspace.requestId) ?? this.byWorkspaceId.get(workspace.id)
      : this.byWorkspaceId.get(workspace.id)
    if (!gate) return false
    gate.workspace = gate.workspace
      ? preferAdvancedWorkspaceDescriptor(gate.workspace, workspace)
      : workspace
    gate.workspaceIds.add(workspace.id)
    this.byWorkspaceId.set(workspace.id, gate)
    if (workspace.status === "error" || workspace.status === "stopped") {
      gate.terminal = { status: workspace.status, message: workspace.error }
    }
    return true
  }

  deferRefreshWorkspace(workspace: T): boolean {
    if (this.deferWorkspace(workspace)) return true
    const path = normalizeWorkspacePath(workspace.path)
    return [...this.byRequestId.values()].some((gate) => gate.expectedPath === path)
  }

  deferStopped(workspaceId: string, message?: string): boolean {
    const gate = this.byWorkspaceId.get(workspaceId)
    const terminal = { status: "stopped" as const, message }
    if (!gate) {
      if (this.byRequestId.size > 0) this.stoppedByWorkspaceId.set(workspaceId, terminal)
      return false
    }
    gate.terminal = terminal
    return true
  }

  resolve(requestId: string, response: T): { workspace: T; terminal?: RestoreWorkspaceTerminal } {
    const gate = this.byRequestId.get(requestId)
    return {
      workspace: gate?.workspace
        ? preferAdvancedWorkspaceDescriptor(response, gate.workspace)
        : response,
      ...(gate?.terminal ? { terminal: gate.terminal } : {}),
    }
  }

  end(requestId: string): void {
    const gate = this.byRequestId.get(requestId)
    if (!gate) return
    this.byRequestId.delete(requestId)
    for (const workspaceId of gate.workspaceIds) {
      if (this.byWorkspaceId.get(workspaceId) === gate) this.byWorkspaceId.delete(workspaceId)
      this.stoppedByWorkspaceId.delete(workspaceId)
    }
    if (this.byRequestId.size === 0) this.stoppedByWorkspaceId.clear()
  }
}
