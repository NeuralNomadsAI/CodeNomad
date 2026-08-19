import { createSignal } from "solid-js"
import type { WorktreeDescriptor } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { getSessionRoot, sessions } from "./session-state"
import { getLogger } from "../lib/logger"
import type { WorktreeReadyEvent } from "../lib/sse-manager"
import { showToastNotification } from "../lib/notifications"
import { tGlobal } from "../lib/i18n"

const log = getLogger("api")

const [worktreesByInstance, setWorktreesByInstance] = createSignal<Map<string, WorktreeDescriptor[]>>(new Map())
const [gitRepoStatusByInstance, setGitRepoStatusByInstance] = createSignal<Map<string, boolean | null>>(new Map())

const worktreeRequests = new Map<string, Promise<void>>()
const worktreeReadyRefreshes = new Map<string, Promise<void>>()
const familyMoveRequests = new Map<string, Promise<void>>()

type WorktreeReadyRefresh = (instanceId: string) => Promise<void>

async function queueWorktreeRequest(instanceId: string, initial: boolean): Promise<void> {
  const previous = worktreeRequests.get(instanceId)
  const task = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    try {
      const response = await serverApi.fetchWorktrees(instanceId)
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
      log.warn(initial ? "Failed to load worktrees" : "Failed to reload worktrees", { instanceId, error })
      if (!initial) throw error

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

async function createWorktree(instanceId: string, slug: string): Promise<{ slug: string; directory: string; branch?: string }> {
  if (!instanceId) {
    throw new Error("Missing instanceId")
  }
  const trimmed = (slug ?? "").trim()
  if (!trimmed) {
    throw new Error("Worktree name is required")
  }
  return serverApi.createWorktree(instanceId, { slug: trimmed })
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
  await Promise.all([
    reloadWorktrees(instanceId),
    refreshSessions(instanceId),
  ]).catch((error) => {
    if (!deleteError) throw error
    log.warn("Failed to refresh after worktree deletion error", { instanceId, slug: trimmed, error })
  })
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
  const normalized = directory.replace(/\\/g, "/").replace(/\/+$/, "")
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
}

function getWorktreeSlugForParentSession(instanceId: string, parentSessionId: string): string {
  const directory = sessions().get(instanceId)?.get(parentSessionId)?.location.directory
  const locationSlug = directory && getWorktrees(instanceId)
    .find((worktree) => normalizeDirectory(worktree.serviceDirectory ?? worktree.directory) === normalizeDirectory(directory))?.slug
  if (locationSlug) return normalizeWorktreeSlug(instanceId, locationSlug)

  return "root"
}

function getWorktreeSlugForSession(instanceId: string, sessionId: string): string {
  const parentId = getParentSessionId(instanceId, sessionId)
  return getWorktreeSlugForParentSession(instanceId, parentId)
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
    await refreshSessions(instanceId).catch((error) => {
      if (!moveError) throw error
      log.warn("Failed to refresh sessions after family move error", { instanceId, rootSessionId, error })
    })
    if (moveError) {
      showToastNotification({
        message: moveError instanceof Error && moveError.message ? moveError.message : tGlobal("sessionList.worktreeMove.error"),
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
