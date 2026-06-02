import { getRootClient } from "./opencode-client"
import { getWorktreeSlugForSession, getWorktrees } from "./worktrees"
import { getLogger } from "../lib/logger"
import { mapOpenCodeWorkspacesToWorktreeSlugs } from "./opencode-workspace-matching"

const log = getLogger("api")

type OpenCodeWorkspace = {
  id: string
  type?: string
  name?: string
  branch?: string | null
  directory?: string | null
  projectID?: string
}

const workspaceIdByWorktreeSlug = new Map<string, Map<string, string>>()
const workspaceSyncs = new Map<string, Promise<void>>()

async function getInstance(instanceId: string) {
  const { instances } = await import("./instances")
  return instances().get(instanceId)
}

function getCachedOpenCodeWorkspaceIdForWorktree(instanceId: string, slug: string): string | null {
  if (!slug || slug === "root") return null
  return workspaceIdByWorktreeSlug.get(instanceId)?.get(slug) ?? null
}

function getCachedOpenCodeWorkspaceIdForSession(instanceId: string, sessionId: string): string | null {
  return getCachedOpenCodeWorkspaceIdForWorktree(instanceId, getWorktreeSlugForSession(instanceId, sessionId))
}

async function syncOpenCodeWorkspaces(instanceId: string): Promise<void> {
  if (!instanceId) return
  const existing = workspaceSyncs.get(instanceId)
  if (existing) return existing

  const task = (async () => {
    const instance = await getInstance(instanceId)
    if (!instance?.client || !instance.folder) return

    const rootClient = getRootClient(instanceId) as any
    const workspaceApi = rootClient.experimental?.workspace
    if (!workspaceApi?.syncList || !workspaceApi?.list) {
      log.warn("OpenCode experimental workspace API unavailable", { instanceId })
      workspaceIdByWorktreeSlug.set(instanceId, new Map())
      return
    }

    await workspaceApi.syncList({ directory: instance.folder })
    const result = await workspaceApi.list({ directory: instance.folder })
    const workspaces = Array.isArray(result?.data) ? (result.data as OpenCodeWorkspace[]) : []
    const next = mapOpenCodeWorkspacesToWorktreeSlugs(getWorktrees(instanceId), workspaces)

    workspaceIdByWorktreeSlug.set(instanceId, next)
  })()
    .catch((error) => {
      log.warn("Failed to sync OpenCode workspaces", { instanceId, error })
      workspaceIdByWorktreeSlug.set(instanceId, new Map())
    })
    .finally(() => {
      workspaceSyncs.delete(instanceId)
    })

  workspaceSyncs.set(instanceId, task)
  return task
}

async function reloadOpenCodeWorkspaces(instanceId: string): Promise<void> {
  workspaceSyncs.delete(instanceId)
  await syncOpenCodeWorkspaces(instanceId)
}

async function getOpenCodeWorkspaceIdForWorktree(instanceId: string, slug: string): Promise<string | null> {
  if (!slug || slug === "root") return null
  const cached = getCachedOpenCodeWorkspaceIdForWorktree(instanceId, slug)
  if (cached) return cached
  await syncOpenCodeWorkspaces(instanceId)
  return getCachedOpenCodeWorkspaceIdForWorktree(instanceId, slug)
}

async function getOpenCodeWorkspaceIdForSession(instanceId: string, sessionId: string): Promise<string | null> {
  const slug = getWorktreeSlugForSession(instanceId, sessionId)
  return getOpenCodeWorkspaceIdForWorktree(instanceId, slug)
}

function clearOpenCodeWorkspaceCache(instanceId: string): void {
  workspaceSyncs.delete(instanceId)
  workspaceIdByWorktreeSlug.delete(instanceId)
}

async function removeOpenCodeWorkspaceForWorktree(instanceId: string, slug: string): Promise<void> {
  const instance = await getInstance(instanceId)
  if (!instance?.folder || !slug || slug === "root") return
  const workspaceId = getCachedOpenCodeWorkspaceIdForWorktree(instanceId, slug)
  if (!workspaceId) return

  const rootClient = getRootClient(instanceId) as any
  const workspaceApi = rootClient.experimental?.workspace
  if (!workspaceApi?.remove) return

  await workspaceApi.remove({ directory: instance.folder, id: workspaceId })
  workspaceIdByWorktreeSlug.get(instanceId)?.delete(slug)
}

export {
  clearOpenCodeWorkspaceCache,
  getCachedOpenCodeWorkspaceIdForSession,
  getCachedOpenCodeWorkspaceIdForWorktree,
  getOpenCodeWorkspaceIdForSession,
  getOpenCodeWorkspaceIdForWorktree,
  reloadOpenCodeWorkspaces,
  removeOpenCodeWorkspaceForWorktree,
  syncOpenCodeWorkspaces,
}
