import { createSignal } from "solid-js"
import type { WorktreeDescriptor } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import { getSessionRoot, sessions } from "./session-state"
import { getLogger } from "../lib/logger"
import type { WorktreeReadyEvent } from "../lib/sse-manager"
import { showToastNotification } from "../lib/notifications"
import { tGlobal } from "../lib/i18n"
import { normalizeSessionDirectory } from "./session-list-options"
import { backgroundReads } from "../lib/background-read-queue"

const log = getLogger("api")

const [worktreesByInstance, setWorktreesByInstance] = createSignal<Map<string, WorktreeDescriptor[]>>(new Map())
const [gitRepoStatusByInstance, setGitRepoStatusByInstance] = createSignal<Map<string, boolean | null>>(new Map())

const worktreeRequests = new Map<string, Promise<void>>()
const pendingWorktreeRefreshes = new Set<string>()
const worktreeReadyRefreshes = new Map<string, Promise<void>>()
const familyMoveRequests = new Map<string, Promise<void>>()
const defaultDirectories = new Map<string, string>()

type WorktreeReadyRefresh = (instanceId: string) => Promise<void>

async function queueWorktreeRequest(instanceId: string, initial: boolean): Promise<void> {
  const existing = worktreeRequests.get(instanceId)
  if (existing) {
    if (!initial) pendingWorktreeRefreshes.add(instanceId)
    return existing
  }
  const load = async (initialRead: boolean) => {
    try {
      const response = await backgroundReads.run(new AbortController().signal, () => serverApi.fetchWorktrees(instanceId))
      if (response.defaultDirectory) defaultDirectories.set(instanceId, response.defaultDirectory)
      else defaultDirectories.delete(instanceId)
      setWorktreesByInstance((prev) => {
        const next = new Map(prev)
        next.set(instanceId, response.worktrees ?? [])
        return next
      })

      setGitRepoStatusByInstance((prev) => {
        const next = new Map(prev)
        next.set(instanceId, typeof response.isGitRepo === "boolean" ? response.isGitRepo : null)
        return next
      })
    } catch (error) {
      log.warn(initialRead ? "Failed to load worktrees" : "Failed to reload worktrees", { instanceId, error })
      if (!initialRead) throw error

      setWorktreesByInstance((prev) => {
        const next = new Map(prev)
        next.set(instanceId, [])
        return next
      })

      // Preserve any previous value; if unknown, keep it unknown.
      setGitRepoStatusByInstance((prev) => {
        if (prev.has(instanceId)) return prev
        const next = new Map(prev)
        next.set(instanceId, null)
        return next
      })
    }
  }
  // Like the provider/model catalogue, retain one in-flight read and one dirty
  // bit. A burst requests one trailing read, not an unbounded HTTP queue.
  const task = Promise.resolve().then(async () => {
    let initialRead = initial
    do {
      pendingWorktreeRefreshes.delete(instanceId)
      try {
        await load(initialRead)
      } catch (error) {
        if (!pendingWorktreeRefreshes.has(instanceId)) throw error
      }
      initialRead = false
    } while (pendingWorktreeRefreshes.has(instanceId))
  })

  worktreeRequests.set(instanceId, task)
  await task.finally(() => {
    if (worktreeRequests.get(instanceId) === task) {
      worktreeRequests.delete(instanceId)
    }
  })
}

async function ensureWorktreesLoaded(instanceId: string): Promise<void> {
  if (!instanceId) return
  if (worktreesByInstance().has(instanceId) && gitRepoStatusByInstance().has(instanceId)) return

  const existing = worktreeRequests.get(instanceId)
  if (existing) {
    await existing
    if (worktreesByInstance().has(instanceId) && gitRepoStatusByInstance().has(instanceId)) return
  }

  await queueWorktreeRequest(instanceId, true)
}

async function reloadWorktrees(instanceId: string): Promise<void> {
  if (!instanceId) return
  await queueWorktreeRequest(instanceId, false)
}

serverEvents.on("workspace.worktreesChanged", (event) => {
  if (event.type !== "workspace.worktreesChanged") return
  const id = event.workspaceId
  // Refresh consumers that already requested this inventory. Queue behind an
  // older HTTP response so it cannot overwrite the completed background scan.
  if (!worktreesByInstance().has(id) && !worktreeRequests.has(id)) return
  void reloadWorktrees(id).catch(error => log.warn("Failed to receive refreshed worktrees", { instanceId: id, error }))
})

async function handleWorktreeReady(
  instanceId: string,
  event: WorktreeReadyEvent,
  refreshWorktrees: WorktreeReadyRefresh = reloadWorktrees,
): Promise<void> {
  if (!instanceId) return

  log.info("OpenCode worktree ready", {
    instanceId,
    directory: event.directory,
    name: event.properties?.name,
  })

  const previous = worktreeReadyRefreshes.get(instanceId)
  const task = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    await refreshWorktrees(instanceId)
  })

  worktreeReadyRefreshes.set(instanceId, task)
  await task.finally(() => {
    if (worktreeReadyRefreshes.get(instanceId) === task) {
      worktreeReadyRefreshes.delete(instanceId)
    }
  })
}

function getGitRepoStatus(instanceId: string): boolean | null {
  return gitRepoStatusByInstance().get(instanceId) ?? null
}

async function createWorktree(instanceId: string, slug: string, fromSlug = "root"): Promise<{ slug: string; directory: string; branch?: string }> {
  if (!instanceId) {
    throw new Error("Missing instanceId")
  }
  const trimmed = (slug ?? "").trim()
  if (!trimmed) {
    throw new Error("Worktree name is required")
  }
  return serverApi.createWorktree(instanceId, { slug: trimmed, fromSlug })
}

async function deleteWorktree(
  instanceId: string,
  slug: string,
  options?: { force?: boolean },
  refreshSessions: (instanceId: string) => Promise<void> = (id) =>
    import("./session-api").then(({ fetchSessions }) => fetchSessions(id, { reset: true, strictStatus: true })),
): Promise<void> {
  if (!instanceId) {
    throw new Error("Missing instanceId")
  }
  const trimmed = (slug ?? "").trim()
  if (!trimmed || trimmed === "root") {
    throw new Error("Invalid worktree")
  }
  let deleteError: unknown
  try {
    await serverApi.deleteWorktree(instanceId, trimmed, options)
  } catch (error) {
    deleteError = error
  }
  const refreshers = [() => reloadWorktrees(instanceId), () => refreshSessions(instanceId)]
  const refreshes = await Promise.allSettled(refreshers.map((refresh) => refresh()))
  const failed = refreshes.flatMap((refresh, index) => refresh.status === "rejected" ? [index] : [])
  if (failed.length) {
    const retries = await Promise.allSettled(failed.map((index) => refreshers[index]!()))
    for (const retry of retries) {
      if (retry.status === "rejected") {
        log.warn("Failed to refresh after worktree deletion", { instanceId, slug: trimmed, error: retry.reason })
      }
    }
  }
  if (deleteError) {
    throw deleteError
  }
}

function getWorktrees(instanceId: string): WorktreeDescriptor[] {
  return worktreesByInstance().get(instanceId) ?? []
}

function normalizeWorktreeSlug(instanceId: string, slug: string): string {
  return (slug ?? "").trim() || "root"
}

function getDefaultWorktreeSlug(instanceId: string): string {
  return normalizeWorktreeSlug(instanceId, "root")
}

function getParentSessionId(instanceId: string, sessionId: string): string {
  return getSessionRoot(instanceId, sessionId)?.id ?? sessionId
}

function normalizeDirectory(directory: string): string {
  return normalizeSessionDirectory(directory)
}

function getWorktreeSlugForParentSession(instanceId: string, parentSessionId: string): string {
  const directory = sessions().get(instanceId)?.get(parentSessionId)?.location.directory
  const locationSlug = directory && getWorktrees(instanceId)
    .find((worktree) => normalizeDirectory(worktree.serviceDirectory ?? worktree.directory) === normalizeDirectory(directory))?.slug
  if (locationSlug) return normalizeWorktreeSlug(instanceId, locationSlug)

  return "root"
}

function getWorktreeSlugForSession(instanceId: string, sessionId: string): string {
  return getWorktreeSlugForParentSession(instanceId, sessionId)
}

export function getDefaultWorktreeDirectory(instanceId: string): string | undefined {
  return defaultDirectories.get(instanceId)
}

async function setWorktreeSlugForParentSession(
  instanceId: string,
  parentSessionId: string,
  slug: string,
  options: {
    currentSlug?: string
    moveFamily?: (instanceId: string, rootSessionId: string, worktreeSlug: string) => Promise<unknown>
    refreshSessions?: (instanceId: string) => Promise<void>
  } = {},
): Promise<void> {
  await ensureWorktreesLoaded(instanceId)
  const rootSessionId = getParentSessionId(instanceId, parentSessionId)
  const normalizedSlug = normalizeWorktreeSlug(instanceId, slug)
  const worktree = getWorktrees(instanceId).find((candidate) => candidate.slug === normalizedSlug)
  if (!worktree) throw new Error(`Worktree not found: ${normalizedSlug}`)

  // Controlled selectors can report their current option while metadata loads.
  // Do not turn that reconciliation into a family move and native move echoes.
  const currentDirectory = sessions().get(instanceId)?.get(rootSessionId)?.location.directory
  const targetDirectory = worktree.serviceDirectory ?? worktree.directory
  if (currentDirectory && normalizeDirectory(currentDirectory) === normalizeDirectory(targetDirectory)) return

  const key = `${instanceId}:${rootSessionId}`
  const previous = familyMoveRequests.get(key)
  const moveFamily = options.moveFamily ?? ((id: string, sessionId: string, worktreeSlug: string) =>
    serverApi.moveSessionFamily(id, sessionId, { worktreeSlug }))
  const refreshSessions = options.refreshSessions ?? ((id: string) =>
    import("./session-api").then(({ fetchSessions }) => fetchSessions(id, { reset: true, strictStatus: true })))
  const task = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    let moveError: unknown
    try {
      await moveFamily(instanceId, rootSessionId, normalizedSlug)
    } catch (error) {
      moveError = error
    }
    try {
      await refreshSessions(instanceId)
    } catch {
      await refreshSessions(instanceId).catch((error) => {
        log.warn("Failed to refresh sessions after family move", { instanceId, rootSessionId, error })
      })
    }
    if (moveError) {
      log.warn("Failed to move session family", { instanceId, rootSessionId, error: moveError })
      showToastNotification({
        message: tGlobal("sessionList.worktreeMove.error"),
        variant: "error",
      })
      throw moveError
    }
  })

  familyMoveRequests.set(key, task)
  await task.finally(() => {
    if (familyMoveRequests.get(key) === task) familyMoveRequests.delete(key)
  })
}

export {
  worktreesByInstance,
  gitRepoStatusByInstance,
  ensureWorktreesLoaded,
  reloadWorktrees,
  handleWorktreeReady,
  getGitRepoStatus,
  getWorktrees,
  getDefaultWorktreeSlug,
  getParentSessionId,
  getWorktreeSlugForParentSession,
  getWorktreeSlugForSession,
  setWorktreeSlugForParentSession,
  createWorktree,
  deleteWorktree,
}
