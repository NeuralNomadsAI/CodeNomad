import { createSignal } from "solid-js"
import type { WorktreeDescriptor, WorktreeMap } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { getSessionRoot, sessions } from "./session-state"
import { getLogger } from "../lib/logger"
import { getCodeNomadSessionMetadata, setSessionWorktreeSlugWithClient } from "./session-metadata"
import { getRootClient } from "./opencode-client"
import type { WorktreeReadyEvent } from "../lib/sse-manager"

const log = getLogger("api")

const [worktreesByInstance, setWorktreesByInstance] = createSignal<Map<string, WorktreeDescriptor[]>>(new Map())
const [worktreeMapByInstance, setWorktreeMapByInstance] = createSignal<Map<string, WorktreeMap>>(new Map())
const [gitRepoStatusByInstance, setGitRepoStatusByInstance] = createSignal<Map<string, boolean | null>>(new Map())

const worktreeRequests = new Map<string, Promise<void>>()
const worktreeReadyRefreshes = new Map<string, Promise<void>>()
const mapLoads = new Map<string, Promise<void>>()
const mapMigrations = new Map<string, Promise<void>>()

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

  log.info("OpenCode worktree ready", {
    instanceId,
    directory: event.directory,
    name: event.properties?.name,
  })

  const previous = worktreeReadyRefreshes.get(instanceId)
  const task = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    await refreshWorktrees(instanceId)
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
  await moveSessionsFromDeletedWorktree(instanceId, trimmed).catch((error) => {
    log.warn("Failed to move sessions from deleted worktree", { instanceId, slug: trimmed, error })
  })
  await import("./opencode-workspaces").then(({ removeOpenCodeWorkspaceForWorktree }) => removeOpenCodeWorkspaceForWorktree(instanceId, trimmed)).catch((error) => {
    log.warn("Failed to remove OpenCode workspace for deleted worktree", { instanceId, slug: trimmed, error })
  })
  await serverApi.deleteWorktree(instanceId, trimmed, options)
  await import("./opencode-workspaces").then(({ reloadOpenCodeWorkspaces }) => reloadOpenCodeWorkspaces(instanceId)).catch((error) => {
    log.warn("Failed to sync OpenCode workspaces after worktree deletion", { instanceId, slug: trimmed, error })
  })
}

async function moveSessionsFromDeletedWorktree(instanceId: string, slug: string): Promise<void> {
  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return

  const parentSessionIds = Array.from(instanceSessions.values())
    .filter((session) => !session.parentId)
    .filter((session) => getWorktreeSlugForParentSession(instanceId, session.id) === slug)
    .map((session) => session.id)

  for (const parentSessionId of parentSessionIds) {
    const client = getRootClient(instanceId)
    await setSessionWorktreeSlugWithClient(client, instanceId, parentSessionId, "root")
    await removeLegacyParentSessionMapping(instanceId, parentSessionId)
  }
}

async function ensureWorktreeMapLoaded(instanceId: string): Promise<void> {
  if (!instanceId) return
  if (worktreeMapByInstance().has(instanceId)) return
  const existing = mapLoads.get(instanceId)
  if (existing) return existing

  const task = serverApi
    .readWorktreeMap(instanceId)
    .then((map) => {
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
  await serverApi
    .readWorktreeMap(instanceId)
    .then((map) => {
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
  const available = new Set(getWorktrees(instanceId).map((wt) => wt.slug))
  available.add("root")

  let changed = false
  let nextDefault = current.defaultWorktreeSlug || "root"
  if (!available.has(nextDefault)) {
    nextDefault = "root"
    changed = true
  }

  const nextMapping: Record<string, string> = { ...(current.parentSessionWorktreeSlug ?? {}) }
  for (const [sessionId, slug] of Object.entries(nextMapping)) {
    if (!available.has(slug)) {
      delete nextMapping[sessionId]
      changed = true
    }
  }

  if (!changed) return false

  const next: WorktreeMap = {
    version: 1,
    defaultWorktreeSlug: nextDefault,
    parentSessionWorktreeSlug: nextMapping,
  }

  setWorktreeMapByInstance((prev) => {
    const map = new Map(prev)
    map.set(instanceId, next)
    return map
  })

  await serverApi.writeWorktreeMap(instanceId, next).catch((error) => {
    log.warn("Failed to persist pruned worktree map", { instanceId, error })
  })

  return true
}

function getDefaultWorktreeSlug(instanceId: string): string {
  return normalizeWorktreeSlug(instanceId, "root")
}

function getParentSessionId(instanceId: string, sessionId: string): string {
  return getSessionRoot(instanceId, sessionId)?.id ?? sessionId
}

function getWorktreeSlugForParentSession(instanceId: string, parentSessionId: string): string {
  const metadataSlug = getCodeNomadSessionMetadata(instanceId, parentSessionId).worktreeSlug
  if (metadataSlug) {
    return normalizeWorktreeSlug(instanceId, metadataSlug)
  }

  const map = getWorktreeMap(instanceId)
  const candidate = map.parentSessionWorktreeSlug[parentSessionId] ?? "root"
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
  const current = getWorktreeMap(instanceId)
  const normalizedSlug = normalizeWorktreeSlug(instanceId, slug)
  const client = getRootClient(instanceId)
  await setSessionWorktreeSlugWithClient(client, instanceId, parentSessionId, normalizedSlug)
  await removeLegacyParentSessionMapping(instanceId, parentSessionId, current)
}

async function removeParentSessionMapping(instanceId: string, parentSessionId: string): Promise<void> {
  await ensureWorktreeMapLoaded(instanceId)
  const current = getWorktreeMap(instanceId)
  const client = getRootClient(instanceId)
  await setSessionWorktreeSlugWithClient(client, instanceId, parentSessionId, "root")
  await removeLegacyParentSessionMapping(instanceId, parentSessionId, current)
}

async function removeLegacyParentSessionMapping(instanceId: string, parentSessionId: string, current = getWorktreeMap(instanceId)): Promise<void> {
  if (!current.parentSessionWorktreeSlug[parentSessionId]) return
  const nextMapping = { ...(current.parentSessionWorktreeSlug ?? {}) }
  delete nextMapping[parentSessionId]
  const next: WorktreeMap = { ...current, parentSessionWorktreeSlug: nextMapping }
  setWorktreeMapByInstance((prev) => {
    const map = new Map(prev)
    map.set(instanceId, next)
    return map
  })

  await serverApi.writeWorktreeMap(instanceId, next).catch((error) => {
    log.warn("Failed to persist legacy worktree mapping removal", { instanceId, parentSessionId, error })
  })
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
      const client = getRootClient(instanceId)
      await setSessionWorktreeSlugWithClient(client, instanceId, parentSessionId, normalizedSlug)
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
  if (!directory) return null
  const list = getWorktrees(instanceId)
  const match = list.find((wt) => wt.directory === directory)
  return match?.slug ?? null
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
  getWorktreeSlugForDirectory,
  createWorktree,
  deleteWorktree,
}
