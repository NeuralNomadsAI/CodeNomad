import { getRootClient } from "./opencode-client"
import { getLogger } from "../lib/logger"
import { mapOpenCodeWorkspacesToWorktreeSlugs } from "./opencode-workspace-matching"
import { createSignal } from "solid-js"

const WORKSPACE_SYNC_TIMEOUT_MS = 5_000

function withWorkspaceSyncTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OpenCode workspace sync timed out")), WORKSPACE_SYNC_TIMEOUT_MS)
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

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
const workspaceIdBySession = new Map<string, Map<string, string>>()
const workspaceSyncs = new Map<string, Promise<void>>()
const workspaceMappingVersions = new Map<string, ReturnType<typeof createSignal<number>>>()

function workspaceMappingVersion(instanceId: string) {
  let version = workspaceMappingVersions.get(instanceId)
  if (!version) {
    version = createSignal(0)
    workspaceMappingVersions.set(instanceId, version)
  }
  return version
}

function publishWorkspaceMap(instanceId: string, map: Map<string, string>): void {
  workspaceIdByWorktreeSlug.set(instanceId, map)
  workspaceMappingVersion(instanceId)[1]((value) => value + 1)
}

async function getInstance(instanceId: string) {
  const { instances } = await import("./instances")
  return instances().get(instanceId)
}

function getCachedOpenCodeWorkspaceIdForWorktree(instanceId: string, slug: string): string | null {
  if (!slug || slug === "root") return null
  workspaceMappingVersion(instanceId)[0]()
  return workspaceIdByWorktreeSlug.get(instanceId)?.get(slug) ?? null
}

function getCachedOpenCodeWorkspaceIdForSession(instanceId: string, sessionId: string): string | null {
  return workspaceIdBySession.get(instanceId)?.get(sessionId) ?? null
}

function getCachedWorktreeSlugForOpenCodeWorkspaceId(instanceId: string, workspaceId: string): string | null {
  workspaceMappingVersion(instanceId)[0]()
  for (const [slug, candidate] of workspaceIdByWorktreeSlug.get(instanceId) ?? []) {
    if (candidate === workspaceId) return slug
  }
  return null
}

function rememberOpenCodeWorkspaceIdForSession(instanceId: string, sessionId: string, workspaceId: string): void {
  const sessions = workspaceIdBySession.get(instanceId) ?? new Map<string, string>()
  sessions.set(sessionId, workspaceId)
  workspaceIdBySession.set(instanceId, sessions)
}

function forgetOpenCodeWorkspaceIdForSession(instanceId: string, sessionId: string): void {
  const sessions = workspaceIdBySession.get(instanceId)
  sessions?.delete(sessionId)
  if (sessions?.size === 0) workspaceIdBySession.delete(instanceId)
}

async function syncOpenCodeWorkspaces(instanceId: string): Promise<void> {
  if (!instanceId) return
  const existing = workspaceSyncs.get(instanceId)
  if (existing) return existing

  const task = (async () => {
    const instance = await getInstance(instanceId)
    if (!instance?.client || !instance.folder) return
    const { getNativeRootDirectory, getWorktrees } = await import("./worktrees")
    const rootDirectory = getNativeRootDirectory(instanceId, instance.folder)

    const rootClient = getRootClient(instanceId) as any
    const workspaceApi = rootClient.experimental?.workspace
    if (!workspaceApi?.syncList || !workspaceApi?.list) {
      log.warn("OpenCode experimental workspace API unavailable", { instanceId })
      publishWorkspaceMap(instanceId, new Map())
      return
    }

    await withWorkspaceSyncTimeout(workspaceApi.syncList({ directory: rootDirectory }))
    const result = await withWorkspaceSyncTimeout<any>(workspaceApi.list({ directory: rootDirectory }))
    const workspaces = Array.isArray(result?.data) ? (result.data as OpenCodeWorkspace[]) : []
    const next = mapOpenCodeWorkspacesToWorktreeSlugs(getWorktrees(instanceId), workspaces)

    publishWorkspaceMap(instanceId, next)
  })()
    .catch((error) => {
      log.warn("Failed to sync OpenCode workspaces", { instanceId, error })
      if (!workspaceIdByWorktreeSlug.has(instanceId)) {
        publishWorkspaceMap(instanceId, new Map())
      }
    })
    .finally(() => {
      if (workspaceSyncs.get(instanceId) === task) {
        workspaceSyncs.delete(instanceId)
      }
    })

  workspaceSyncs.set(instanceId, task)
  return task
}

async function reloadOpenCodeWorkspaces(instanceId: string): Promise<void> {
  await workspaceSyncs.get(instanceId)
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
  const cached = getCachedOpenCodeWorkspaceIdForSession(instanceId, sessionId)
  if (cached) return cached
  const { getWorktreeSlugForSession } = await import("./worktrees")
  const slug = getWorktreeSlugForSession(instanceId, sessionId)
  return getOpenCodeWorkspaceIdForWorktree(instanceId, slug)
}

async function getWorktreeSlugForOpenCodeWorkspaceId(instanceId: string, workspaceId: string): Promise<string | null> {
  const cached = getCachedWorktreeSlugForOpenCodeWorkspaceId(instanceId, workspaceId)
  if (cached) return cached
  await syncOpenCodeWorkspaces(instanceId)
  return getCachedWorktreeSlugForOpenCodeWorkspaceId(instanceId, workspaceId)
}

function clearOpenCodeWorkspaceCache(instanceId: string): void {
  workspaceSyncs.delete(instanceId)
  workspaceIdByWorktreeSlug.delete(instanceId)
  workspaceIdBySession.delete(instanceId)
  workspaceMappingVersions.get(instanceId)?.[1]((value) => value + 1)
}

async function removeOpenCodeWorkspaceForWorktree(instanceId: string, slug: string): Promise<void> {
  const instance = await getInstance(instanceId)
  if (!instance?.folder || !slug || slug === "root") return
  const workspaceId = getCachedOpenCodeWorkspaceIdForWorktree(instanceId, slug)
  if (!workspaceId) return

  const rootClient = getRootClient(instanceId) as any
  const workspaceApi = rootClient.experimental?.workspace
  if (!workspaceApi?.remove) return

  const { getNativeRootDirectory } = await import("./worktrees")
  await workspaceApi.remove({ directory: getNativeRootDirectory(instanceId, instance.folder), id: workspaceId })
  workspaceIdByWorktreeSlug.get(instanceId)?.delete(slug)
  workspaceMappingVersion(instanceId)[1]((value) => value + 1)
}

export {
  clearOpenCodeWorkspaceCache,
  getCachedOpenCodeWorkspaceIdForSession,
  getCachedOpenCodeWorkspaceIdForWorktree,
  getCachedWorktreeSlugForOpenCodeWorkspaceId,
  getOpenCodeWorkspaceIdForSession,
  getOpenCodeWorkspaceIdForWorktree,
  getWorktreeSlugForOpenCodeWorkspaceId,
  forgetOpenCodeWorkspaceIdForSession,
  rememberOpenCodeWorkspaceIdForSession,
  reloadOpenCodeWorkspaces,
  removeOpenCodeWorkspaceForWorktree,
  syncOpenCodeWorkspaces,
}
