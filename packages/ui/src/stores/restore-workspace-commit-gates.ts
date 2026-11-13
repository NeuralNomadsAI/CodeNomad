import type { WorkspaceDescriptor } from "../../../server/src/api-types"
import { normalizeWorkspacePath } from "./app-session-reconciliation"
import { LOCAL_BACKEND_ID, parseInstanceKey } from "../lib/backend-identity"

export interface RestoreWorkspaceTerminal {
  status: "error" | "stopped"
  message?: string
}

export interface RestoreWorkspaceCommitGate<T extends WorkspaceDescriptor> {
  requestId: string
  backendId: string
  current: () => boolean
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
  private readonly stoppedByWorkspaceId = new Map<string, RestoreWorkspaceTerminal & { current: () => boolean }>()

  begin(requestId: string, wait: Promise<void>, expectedPath?: string, backendId = LOCAL_BACKEND_ID, current = () => true): RestoreWorkspaceCommitGate<T> {
    const gate = {
      requestId, backendId, current, wait, workspaceIds: new Set<string>(),
      ...(expectedPath ? { expectedPath: normalizeWorkspacePath(expectedPath) } : {}),
    }
    this.byRequestId.set(this.requestKey(backendId, requestId), gate)
    return gate
  }

  private requestKey(backendId: string, requestId: string): string {
    return JSON.stringify([backendId, requestId])
  }

  bindResponse(requestId: string, workspaceId: string, owner?: () => boolean): void {
    const gate = this.byRequestId.get(this.requestKey(parseInstanceKey(workspaceId).backendId, requestId))
    if (!gate || owner && gate.current !== owner) return
    gate.workspaceIds.add(workspaceId)
    this.byWorkspaceId.set(workspaceId, gate)
    const stopped = this.stoppedByWorkspaceId.get(workspaceId)
    if (stopped) {
      if (stopped.current() && gate.current()) gate.terminal = { status: stopped.status, message: stopped.message }
      this.stoppedByWorkspaceId.delete(workspaceId)
    }
  }

  deferWorkspace(workspace: T): boolean {
    const gate = workspace.requestId
      ? this.byRequestId.get(this.requestKey(parseInstanceKey(workspace.id).backendId, workspace.requestId)) ?? this.byWorkspaceId.get(workspace.id)
      : this.byWorkspaceId.get(workspace.id)
    if (!gate?.current()) return false
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
    return [...this.byRequestId.values()].some((gate) => gate.current() && gate.backendId === parseInstanceKey(workspace.id).backendId && gate.expectedPath === path)
  }

  deferStopped(workspaceId: string, message?: string): boolean {
    const gate = this.byWorkspaceId.get(workspaceId)
    const terminal = { status: "stopped" as const, message }
    if (!gate?.current()) {
      const pending = [...this.byRequestId.values()].find(gate => gate.current() && gate.backendId === parseInstanceKey(workspaceId).backendId)
      if (pending) {
        this.stoppedByWorkspaceId.set(workspaceId, { ...terminal, current: pending.current })
      }
      return false
    }
    gate.terminal = terminal
    return true
  }

  resolve(requestId: string, response: T, backendId = parseInstanceKey(response.id).backendId, owner?: () => boolean): { workspace: T; terminal?: RestoreWorkspaceTerminal } {
    const candidate = this.byRequestId.get(this.requestKey(backendId, requestId))
    const gate = !owner || candidate?.current === owner ? candidate : undefined
    return {
      workspace: gate?.workspace
        ? preferAdvancedWorkspaceDescriptor(response, gate.workspace)
        : response,
      ...(gate?.terminal ? { terminal: gate.terminal } : {}),
    }
  }

  end(requestId: string, backendId = LOCAL_BACKEND_ID, owner?: () => boolean): void {
    const key = this.requestKey(backendId, requestId)
    const gate = this.byRequestId.get(key)
    if (!gate || owner && gate.current !== owner) return
    this.byRequestId.delete(key)
    for (const workspaceId of gate.workspaceIds) {
      if (this.byWorkspaceId.get(workspaceId) === gate) {
        this.byWorkspaceId.delete(workspaceId)
        if (gate.current()) this.stoppedByWorkspaceId.delete(workspaceId)
      }
    }
    if (this.byRequestId.size === 0) this.stoppedByWorkspaceId.clear()
  }
}
