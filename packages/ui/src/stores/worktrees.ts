import { createSignal } from "solid-js"
import type { WorktreeDescriptor, WorktreeMap } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { getSessionRoot, sessions } from "./session-state"
import { getLogger } from "../lib/logger"
import { getCodeNomadSessionMetadata, setSessionWorktreeSlug } from "./session-metadata"
import type { WorktreeReadyEvent } from "../lib/sse-manager"
import { findWorktreeSlugForDirectory } from "./opencode-workspace-matching"
import { tGlobal } from "../lib/i18n"
import { messageStoreBus } from "./message-v2/bus"
import { getCachedWorktreeSlugForOpenCodeWorkspaceId } from "./opencode-workspaces"

const log = getLogger("api")

const [worktreesByInstance, setWorktreesByInstance] = createSignal<Map<string, WorktreeDescriptor[]>>(new Map())
const [worktreeMapByInstance, setWorktreeMapByInstance] = createSignal<Map<string, WorktreeMap>>(new Map())
const [gitRepoStatusByInstance, setGitRepoStatusByInstance] = createSignal<Map<string, boolean | null>>(new Map())

const worktreeRequests = new Map<string, Promise<void>>()
const worktreeReadyRefreshes = new Map<string, Promise<void>>()
const mapLoads = new Map<string, Promise<void>>()
const mapMigrations = new Map<string, Promise<void>>()
const mapUpdates = new Map<string, Promise<void>>()
const worktreeDeletions = new Set<string>()
const lifecycleGenerations = new Map<string, number>()

function lifecycleGeneration(instanceId: string): number {
  return lifecycleGenerations.get(instanceId) ?? 0
}

function isCurrentLifecycle(instanceId: string, generation: number): boolean {
  return lifecycleGeneration(instanceId) === generation
}

function clearWorktreeState(instanceId: string): void {
  lifecycleGenerations.set(instanceId, lifecycleGeneration(instanceId) + 1)
  for (const pending of [worktreeRequests, worktreeReadyRefreshes, mapLoads, mapMigrations, mapUpdates]) pending.delete(instanceId)
  for (const key of worktreeDeletions) {
    if (key.startsWith(`${instanceId}:`)) worktreeDeletions.delete(key)
  }
  setWorktreesByInstance((current) => {
    const next = new Map(current)
    next.delete(instanceId)
    return next
  })
  setWorktreeMapByInstance((current) => {
    const next = new Map(current)
    next.delete(instanceId)
    return next
  })
  setGitRepoStatusByInstance((current) => {
    const next = new Map(current)
    next.delete(instanceId)
    return next
  })
}

messageStoreBus.onInstanceDestroyed(clearWorktreeState)

type WorktreeReadyRefresh = (instanceId: string) => Promise<void>

function normalizeMap(input?: WorktreeMap | null): WorktreeMap {
  if (!input || typeof input !== "object") {
    return { version: 1, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: {} }
  }
  return {
    version: 1,
    defaultWorktreeSlug: input.defaultWorktreeSlug || "root",
    parentSessionWorktreeSlug: input.parentSessionWorktreeSlug ?? {},
  }
}

async function queueWorktreeRequest(instanceId: string, initial: boolean): Promise<void> {
  const generation = lifecycleGeneration(instanceId)
  const previous = worktreeRequests.get(instanceId)
  const task = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    try {
      const response = await serverApi.fetchWorktrees(instanceId)
      if (!isCurrentLifecycle(instanceId, generation)) return
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

      // If we already loaded a worktree mapping, drop stale slugs.
      if (worktreeMapByInstance().has(instanceId)) {
        void pruneWorktreeMap(instanceId).catch(() => undefined)
      }
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
  refreshWorkspaces: WorktreeReadyRefresh = async (id) => {
    const { reloadOpenCodeWorkspaces } = await import("./opencode-workspaces")
    await reloadOpenCodeWorkspaces(id)
  },
): Promise<void> {
  if (!instanceId) return
  const generation = lifecycleGeneration(instanceId)

  log.info("OpenCode worktree ready", {
    instanceId,
    directory: event.directory,
    name: event.properties?.name,
  })

  const previous = worktreeReadyRefreshes.get(instanceId)
  const task = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    await refreshWorktrees(instanceId)
    if (!isCurrentLifecycle(instanceId, generation)) return
    await refreshWorkspaces(instanceId)
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
  const worktree = await serverApi.createWorktree(instanceId, { slug: trimmed })
  await import("./opencode-workspaces").then(({ reloadOpenCodeWorkspaces }) => reloadOpenCodeWorkspaces(instanceId)).catch((error) => {
    log.warn("Failed to sync OpenCode workspaces after worktree creation", { instanceId, slug: trimmed, error })
  })
  return worktree
}

async function deleteWorktree(instanceId: string, slug: string, options?: { force?: boolean }): Promise<void> {
  if (!instanceId) {
    throw new Error("Missing instanceId")
  }
  const trimmed = (slug ?? "").trim()
  if (!trimmed || trimmed === "root") {
    throw new Error("Invalid worktree")
  }
  const deletionKey = `${instanceId}:${trimmed}`
  if (worktreeDeletions.has(deletionKey)) throw new Error(tGlobal("instanceShell.worktree.moveFailed"))
  worktreeDeletions.add(deletionKey)
  try {
    await serverApi.deleteWorktree(instanceId, trimmed, options)
    await Promise.all([reloadWorktrees(instanceId), reloadWorktreeMap(instanceId)])
    await import("./opencode-workspaces").then(({ removeOpenCodeWorkspaceForWorktree }) => removeOpenCodeWorkspaceForWorktree(instanceId, trimmed)).catch((error) => {
      log.warn("Failed to remove OpenCode workspace for deleted worktree", { instanceId, slug: trimmed, error })
    })
    await import("./opencode-workspaces").then(({ reloadOpenCodeWorkspaces }) => reloadOpenCodeWorkspaces(instanceId)).catch((error) => {
      log.warn("Failed to sync OpenCode workspaces after worktree deletion", { instanceId, slug: trimmed, error })
    })
  } catch (error) {
    await Promise.all([
      import("./session-api").then(({ fetchSessions }) => fetchSessions(instanceId, { reset: false, strictStatus: true })),
      reloadWorktrees(instanceId),
      reloadWorktreeMap(instanceId),
    ]).catch(() => undefined)
    throw error
  } finally {
    worktreeDeletions.delete(deletionKey)
  }
}

function isWorktreeDeletionInProgress(instanceId: string, slug: string): boolean {
  return worktreeDeletions.has(`${instanceId}:${slug}`)
}

async function ensureWorktreeMapLoaded(instanceId: string): Promise<void> {
  if (!instanceId) return
  if (worktreeMapByInstance().has(instanceId)) return
  const existing = mapLoads.get(instanceId)
  if (existing) return existing

  const generation = lifecycleGeneration(instanceId)
  const task = serverApi
    .readWorktreeMap(instanceId)
    .then((map) => {
      if (!isCurrentLifecycle(instanceId, generation)) return
      setWorktreeMapByInstance((prev) => {
        const next = new Map(prev)
        next.set(instanceId, normalizeMap(map))
        return next
      })

      // If worktrees are already loaded, prune any mappings that reference missing worktrees.
      if (worktreesByInstance().has(instanceId)) {
        void pruneWorktreeMap(instanceId).catch(() => undefined)
      }
      void migrateLegacyWorktreeMapToSessionMetadata(instanceId).catch((error) => {
        log.warn("Failed to migrate legacy worktree map", { instanceId, error })
      })
    })
    .catch((error) => {
      if (!isCurrentLifecycle(instanceId, generation)) return
      log.warn("Failed to load worktree map", { instanceId, error })
      setWorktreeMapByInstance((prev) => {
        const next = new Map(prev)
        next.set(instanceId, normalizeMap(null))
        return next
      })
    })
    .finally(() => {
      mapLoads.delete(instanceId)
    })

  mapLoads.set(instanceId, task)
  return task
}

async function reloadWorktreeMap(instanceId: string): Promise<void> {
  if (!instanceId) return
  const generation = lifecycleGeneration(instanceId)
  await serverApi
    .readWorktreeMap(instanceId)
    .then((map) => {
      if (!isCurrentLifecycle(instanceId, generation)) return
      setWorktreeMapByInstance((prev) => {
        const next = new Map(prev)
        next.set(instanceId, normalizeMap(map))
        return next
      })
    })
    .catch((error) => {
      log.warn("Failed to reload worktree map", { instanceId, error })
    })
}

function getWorktrees(instanceId: string): WorktreeDescriptor[] {
  return worktreesByInstance().get(instanceId) ?? []
}

function getNativeRootDirectory(instanceId: string, fallback = ""): string {
  const root = getWorktrees(instanceId).find((worktree) => worktree.slug === "root")
  return root?.nativeDirectory ?? root?.directory ?? fallback
}

function getWorktreeMap(instanceId: string): WorktreeMap {
  return worktreeMapByInstance().get(instanceId) ?? normalizeMap(null)
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

async function pruneWorktreeMap(instanceId: string): Promise<boolean> {
  const current = getWorktreeMap(instanceId)
  const next = await serverApi.pruneWorktreeMap(instanceId)

  setWorktreeMapByInstance((prev) => {
    const map = new Map(prev)
    map.set(instanceId, next)
    return map
  })

  return JSON.stringify(current) !== JSON.stringify(next)
}

function getDefaultWorktreeSlug(instanceId: string): string {
  return normalizeWorktreeSlug(instanceId, "root")
}

function getParentSessionId(instanceId: string, sessionId: string): string {
  return getSessionRoot(instanceId, sessionId)?.id ?? sessionId
}

function getWorktreeSlugForParentSession(instanceId: string, parentSessionId: string): string {
  const session = sessions().get(instanceId)?.get(parentSessionId)
  const nativeSlug = session?.workspaceId
    ? getCachedWorktreeSlugForOpenCodeWorkspaceId(instanceId, session.workspaceId)
      ?? findWorktreeSlugForDirectory(getWorktrees(instanceId), session.directory)
    : null
  if (nativeSlug) return nativeSlug
  if (session?.workspaceId) return "root"

  const metadataSlug = getCodeNomadSessionMetadata(instanceId, parentSessionId).worktreeSlug
  if (metadataSlug) {
    return normalizeWorktreeSlug(instanceId, metadataSlug)
  }

  const map = getWorktreeMap(instanceId)
  const candidate = map.parentSessionWorktreeSlug[parentSessionId]
    ?? findWorktreeSlugForDirectory(getWorktrees(instanceId), session?.directory)
    ?? "root"
  return normalizeWorktreeSlug(instanceId, candidate)
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
  await ensureWorktreeMapLoaded(instanceId)
  const normalizedSlug = normalizeWorktreeSlug(instanceId, slug)
  await setSessionWorktreeSlug(instanceId, parentSessionId, normalizedSlug)
  await removeLegacyParentSessionMapping(instanceId, parentSessionId)
}

async function removeParentSessionMapping(instanceId: string, parentSessionId: string): Promise<void> {
  await ensureWorktreeMapLoaded(instanceId)
  await setSessionWorktreeSlug(instanceId, parentSessionId, "root")
  await removeLegacyParentSessionMapping(instanceId, parentSessionId)
}

async function removeLegacyParentSessionMapping(instanceId: string, parentSessionId: string): Promise<void> {
  const task = (mapUpdates.get(instanceId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await ensureWorktreeMapLoaded(instanceId)
    const current = getWorktreeMap(instanceId)
    if (!current.parentSessionWorktreeSlug[parentSessionId]) return
    const next = await serverApi.removeWorktreeMapSession(instanceId, parentSessionId)
    setWorktreeMapByInstance((prev) => {
      const map = new Map(prev)
      map.set(instanceId, next)
      return map
    })
  }).finally(() => {
    if (mapUpdates.get(instanceId) === task) mapUpdates.delete(instanceId)
  })
  mapUpdates.set(instanceId, task)
  return task
}

async function migrateLegacyWorktreeMapToSessionMetadata(instanceId: string): Promise<void> {
  if (!instanceId) return
  const existing = mapMigrations.get(instanceId)
  if (existing) return existing

  const task = (async () => {
    const map = getWorktreeMap(instanceId)
    const entries = Object.entries(map.parentSessionWorktreeSlug ?? {})
    if (entries.length === 0) return

    for (const [parentSessionId, legacySlug] of entries) {
      const parentSession = sessions().get(instanceId)?.get(parentSessionId)
      if (!parentSession) continue
      if (getCodeNomadSessionMetadata(instanceId, parentSessionId).worktreeSlug) {
        await removeLegacyParentSessionMapping(instanceId, parentSessionId)
        continue
      }

      const normalizedSlug = normalizeWorktreeSlug(instanceId, legacySlug || "root")
      await setSessionWorktreeSlug(instanceId, parentSessionId, normalizedSlug)
      await removeLegacyParentSessionMapping(instanceId, parentSessionId)
    }
  })().finally(() => {
    mapMigrations.delete(instanceId)
  })

  mapMigrations.set(instanceId, task)
  return task
}

async function pruneStaleLegacyWorktreeMapEntries(instanceId: string): Promise<void> {
  if (!instanceId) return
  const migration = mapMigrations.get(instanceId)
  if (migration) await migration.catch(() => undefined)

  const map = getWorktreeMap(instanceId)
  const entries = Object.entries(map.parentSessionWorktreeSlug ?? {})
  if (entries.length === 0) return

  const instanceSessions = sessions().get(instanceId) ?? new Map()
  for (const [parentSessionId] of entries) {
    if (!instanceSessions.has(parentSessionId)) {
      await removeLegacyParentSessionMapping(instanceId, parentSessionId)
    }
  }
}

function getWorktreeSlugForDirectory(instanceId: string, directory: string | undefined): string | null {
  return findWorktreeSlugForDirectory(getWorktrees(instanceId), directory)
}

export {
  worktreesByInstance,
  worktreeMapByInstance,
  gitRepoStatusByInstance,
  ensureWorktreesLoaded,
  reloadWorktrees,
  handleWorktreeReady,
  reloadWorktreeMap,
  ensureWorktreeMapLoaded,
  getGitRepoStatus,
  getWorktrees,
  getNativeRootDirectory,
  getWorktreeMap,
  getDefaultWorktreeSlug,
  getParentSessionId,
  getWorktreeSlugForParentSession,
  getWorktreeSlugForSession,
  setWorktreeSlugForParentSession,
  removeParentSessionMapping,
  migrateLegacyWorktreeMapToSessionMetadata,
  pruneStaleLegacyWorktreeMapEntries,
  removeLegacyParentSessionMapping,
  isWorktreeDeletionInProgress,
  getWorktreeSlugForDirectory,
  createWorktree,
  deleteWorktree,
}
