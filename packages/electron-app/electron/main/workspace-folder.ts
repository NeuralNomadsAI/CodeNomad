import type { WorkspaceDescriptor } from "../../../server/src/api-types"

export class WorkspaceLocalOnlyError extends Error {
  readonly code = "explicit_capability_unavailable"
  readonly capability = "files"
  readonly reason = { code: "localOnly" } as const
  constructor() {
    super(JSON.stringify({ code: "explicit_capability_unavailable", capability: "files", reason: { code: "localOnly" } }))
  }
}

/** Read authority from the local backend, before handing any path to host adapters. */
export async function resolveLocalWorkspaceFolder(
  instanceId: string,
  worktreeSlug: string,
  getJson: (path: string) => Promise<unknown>,
): Promise<string> {
  const route = `/api/workspaces/${encodeURIComponent(instanceId)}`
  const workspace = await getJson(route) as Pick<WorkspaceDescriptor, "path" | "binding">
  if (workspace.binding !== undefined && workspace.binding?.serverId !== "local-shared") throw new WorkspaceLocalOnlyError()
  if (typeof workspace.path !== "string") throw new Error("Workspace path is unavailable")
  if (worktreeSlug === "root") return workspace.path
  const payload = await getJson(`${route}/worktrees`) as { worktrees?: Array<{ slug?: unknown; directory?: unknown }> }
  const worktree = payload.worktrees?.find(candidate => candidate.slug === worktreeSlug)
  if (!worktree || typeof worktree.directory !== "string") throw new Error("Selected worktree is unavailable")
  return worktree.directory
}
