import { createSignal } from "solid-js"
import type { WorktreeDescriptor } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { getSessionRoot, sessions, withSession } from "./session-state"
import { getLogger } from "../lib/logger"
import type { WorktreeReadyEvent } from "../lib/sse-manager"
import { getRootClient } from "./opencode-client"

const log = getLogger("api")

const [worktreesByInstance, setWorktreesByInstance] = createSignal<Map<string, WorktreeDescriptor[]>>(new Map())
const [gitRepoStatusByInstance, setGitRepoStatusByInstance] = createSignal<Map<string, boolean | null>>(new Map())

const worktreeRequests = new Map<string, Promise<void>>()
const worktreeReadyRefreshes = new Map<string, Promise<void>>()

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
      if (!initial) return

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

async function deleteWorktree(instanceId: string, slug: string, options?: { force?: boolean }): Promise<void> {
  if (!instanceId) {
    throw new Error("Missing instanceId")
  }
  const trimmed = (slug ?? "").trim()
  if (!trimmed || trimmed === "root") {
    throw new Error("Invalid worktree")
  }
  await moveSessionsFromDeletedWorktree(instanceId, trimmed).catch((error) => {
    log.warn("Failed to move sessions from deleted worktree", { instanceId, slug: trimmed, error })
  })
  await serverApi.deleteWorktree(instanceId, trimmed, options)
}

async function moveSessionsFromDeletedWorktree(instanceId: string, slug: string): Promise<void> {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return

  const parentSessionIds = Array.from(instanceSessions.values())
    .filter((session) => !session.parentId)
    .filter((session) => getWorktreeSlugForParentSession(instanceId, session.id) === slug)
    .map((session) => session.id)

  for (const parentSessionId of parentSessionIds) {
    await setWorktreeSlugForParentSession(instanceId, parentSessionId, "root")
  }
}

function getWorktrees(instanceId: string): WorktreeDescriptor[] {
  return worktreesByInstance().get(instanceId) ?? []
}

function isWorktreeSlugAvailable(instanceId: string, slug: string): boolean {
  const normalized = (slug ?? "").trim() || "root"
  if (normalized === "root") return true

  const list = getWorktrees(instanceId)
  // If worktrees aren't loaded yet, don't force root incorrectly.
  if (list.length === 0) return true
  return list.some((wt) => wt.slug === normalized)
}

function normalizeWorktreeSlug(instanceId: string, slug: string): string {
  const normalized = (slug ?? "").trim() || "root"
  if (normalized === "root") return "root"
  return isWorktreeSlugAvailable(instanceId, normalized) ? normalized : "root"
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
    .find((worktree) => normalizeDirectory(worktree.directory) === normalizeDirectory(directory))?.slug
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
  _options: { currentSlug?: string } = {},
): Promise<void> {
  await ensureWorktreesLoaded(instanceId)
  const normalizedSlug = normalizeWorktreeSlug(instanceId, slug)
  const worktree = getWorktrees(instanceId).find((candidate) => candidate.slug === normalizedSlug)
  if (!worktree) throw new Error(`Worktree not found: ${normalizedSlug}`)

  await getRootClient(instanceId).session.move({
    sessionID: parentSessionId,
    directory: worktree.directory,
  })
  withSession(instanceId, parentSessionId, (session) => {
    session.location = { directory: worktree.directory }
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
