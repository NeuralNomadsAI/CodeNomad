import { parseInstanceKey } from "../lib/backend-identity"
import type { BackendId } from "../lib/backend-transport"

export interface WorkspaceListRequestFence {
  requestRevision: number
  mutationRevision: number
}

export class WorkspaceListReconciliationFence {
  private requestRevision = 0
  private mutationRevision = 0
  private readonly workspaceRevisions = new Map<string, number>()

  begin(): WorkspaceListRequestFence {
    return {
      requestRevision: ++this.requestRevision,
      mutationRevision: this.mutationRevision,
    }
  }

  markMutation(workspaceId: string): void {
    this.workspaceRevisions.set(workspaceId, ++this.mutationRevision)
  }

  isCurrent(request: WorkspaceListRequestFence): boolean {
    return request.requestRevision === this.requestRevision
  }

  allows(request: WorkspaceListRequestFence, workspaceId: string): boolean {
    return this.isCurrent(request)
      && (this.workspaceRevisions.get(workspaceId) ?? 0) <= request.mutationRevision
  }

  complete(request: WorkspaceListRequestFence): void {
    if (!this.isCurrent(request)) return
    this.workspaceRevisions.clear()
    this.requestRevision += 1
  }
}

export interface BackendWorkspaceListRequestFence extends WorkspaceListRequestFence {
  backendId: BackendId
}

/**
 * One fence per backend, addressed by instance key: a list request or its completion
 * concerns only its backend, so one backend's refresh never clears another's mutations.
 */
export class BackendWorkspaceListReconciliationFence {
  private readonly fences = new Map<BackendId, WorkspaceListReconciliationFence>()

  private fence(backendId: BackendId): WorkspaceListReconciliationFence {
    let fence = this.fences.get(backendId)
    if (!fence) this.fences.set(backendId, fence = new WorkspaceListReconciliationFence())
    return fence
  }

  begin(backendId: BackendId): BackendWorkspaceListRequestFence {
    return { backendId, ...this.fence(backendId).begin() }
  }

  markMutation(instanceId: string): void {
    this.fence(parseInstanceKey(instanceId).backendId).markMutation(instanceId)
  }

  isCurrent(request: BackendWorkspaceListRequestFence): boolean {
    return this.fence(request.backendId).isCurrent(request)
  }

  allows(request: BackendWorkspaceListRequestFence, instanceId: string): boolean {
    return parseInstanceKey(instanceId).backendId === request.backendId && this.fence(request.backendId).allows(request, instanceId)
  }

  complete(request: BackendWorkspaceListRequestFence): void {
    this.fence(request.backendId).complete(request)
  }
}
