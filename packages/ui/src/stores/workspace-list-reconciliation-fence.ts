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
