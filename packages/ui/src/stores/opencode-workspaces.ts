import { getRootClient } from "./opencode-client"
import { getWorktreeSlugForSession, getWorktrees } from "./worktrees"
import { getLogger } from "../lib/logger"
import { mapOpenCodeWorkspacesToWorktreeSlugs } from "./opencode-workspace-matching"

const WORKSPACE_SYNC_TIMEOUT_MS = 5_000

async function withWorkspaceSyncTimeout<T>(
  controller: AbortController,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectAbort!: (reason?: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => rejectAbort(controller.signal.reason)
  if (controller.signal.aborted) onAbort()
  else controller.signal.addEventListener("abort", onAbort, { once: true })
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("OpenCode workspace sync timed out")
      controller.abort(error)
      reject(error)
    }, WORKSPACE_SYNC_TIMEOUT_MS)
  })
  try {
    return await Promise.race([operation(controller.signal), timeout, aborted])
  } finally {
    if (timer) clearTimeout(timer)
    controller.signal.removeEventListener("abort", onAbort)
  }
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
type WorkspaceSync = {
  promise: Promise<void>
  controller: AbortController
  controllers: Set<AbortController>
}
const workspaceSyncs = new Map<string, WorkspaceSync>()

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

function startWorkspaceSync(instanceId: string, previous?: WorkspaceSync, reset = false): WorkspaceSync {
  let runtimeToken: symbol | undefined
  const controller = new AbortController()
  const isCurrent = async () => (await getInstance(instanceId))?.runtimeToken === runtimeToken
  let task!: Promise<void>
  task = (async () => {
    await previous?.promise
    controller.signal.throwIfAborted()
    if (reset) workspaceIdByWorktreeSlug.delete(instanceId)
    const instance = await getInstance(instanceId)
    if (!instance?.client || !instance.folder) return
    runtimeToken = instance.runtimeToken

    const rootClient = getRootClient(instanceId) as any
    const workspaceApi = rootClient.experimental?.workspace
    if (!workspaceApi?.syncList || !workspaceApi?.list) {
      log.warn("OpenCode experimental workspace API unavailable", { instanceId })
      if (await isCurrent()) workspaceIdByWorktreeSlug.set(instanceId, new Map())
      return
    }

    const result = await withWorkspaceSyncTimeout<any>(controller, async (signal) => {
      await workspaceApi.syncList({ directory: instance.folder }, { signal })
      signal.throwIfAborted()
      if (!await isCurrent()) return null
      return workspaceApi.list({ directory: instance.folder }, { signal })
    })
    if (!await isCurrent()) return
    const workspaces = Array.isArray(result?.data) ? (result.data as OpenCodeWorkspace[]) : []
    const next = mapOpenCodeWorkspacesToWorktreeSlugs(getWorktrees(instanceId), workspaces)

    workspaceIdByWorktreeSlug.set(instanceId, next)
  })()
    .catch(async (error) => {
      if (controller.signal.aborted) {
        if (controller.signal.reason instanceof Error && controller.signal.reason.message === "OpenCode workspace sync timed out" && await isCurrent()) {
          log.warn("Failed to sync OpenCode workspaces", { instanceId, error })
          workspaceIdByWorktreeSlug.set(instanceId, new Map())
        }
        return
      }
      if (!await isCurrent()) return
      log.warn("Failed to sync OpenCode workspaces", { instanceId, error })
      if (!workspaceIdByWorktreeSlug.has(instanceId)) {
        workspaceIdByWorktreeSlug.set(instanceId, new Map())
      }
    })
    .finally(() => {
      if (workspaceSyncs.get(instanceId)?.promise === task) {
        workspaceSyncs.delete(instanceId)
      }
    })

  const sync = {
    promise: task,
    controller,
    controllers: new Set([...(previous?.controllers ?? []), controller]),
  }
  workspaceSyncs.set(instanceId, sync)
  return sync
}

async function awaitWorkspaceSync(instanceId: string, initial: WorkspaceSync): Promise<void> {
  let current = initial
  while (true) {
    await current.promise
    const replacement = workspaceSyncs.get(instanceId)
    if (!replacement || replacement === current) return
    current = replacement
  }
}

async function syncOpenCodeWorkspaces(instanceId: string): Promise<void> {
  if (!instanceId) return
  const sync = workspaceSyncs.get(instanceId) ?? startWorkspaceSync(instanceId)
  await awaitWorkspaceSync(instanceId, sync)
}

async function reloadOpenCodeWorkspaces(instanceId: string): Promise<void> {
  if (!instanceId) return
  const replacement = startWorkspaceSync(instanceId, workspaceSyncs.get(instanceId), true)
  await awaitWorkspaceSync(instanceId, replacement)
}

async function getOpenCodeWorkspaceIdForWorktree(instanceId: string, slug: string): Promise<string | null> {
  if (!slug || slug === "root") return null
  if (workspaceIdByWorktreeSlug.has(instanceId)) return getCachedOpenCodeWorkspaceIdForWorktree(instanceId, slug)
  await syncOpenCodeWorkspaces(instanceId)
  return getCachedOpenCodeWorkspaceIdForWorktree(instanceId, slug)
}

async function getOpenCodeWorkspaceIdForSession(instanceId: string, sessionId: string): Promise<string | null> {
  const slug = getWorktreeSlugForSession(instanceId, sessionId)
  return getOpenCodeWorkspaceIdForWorktree(instanceId, slug)
}

function clearOpenCodeWorkspaceCache(instanceId: string): void {
  for (const controller of workspaceSyncs.get(instanceId)?.controllers ?? []) controller.abort()
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
