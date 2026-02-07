import { createSignal } from "solid-js"
import type { WorktreeDescriptor, WorktreeMap } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { sdkManager, type OpencodeClient } from "../lib/sdk-manager"
import { sessions } from "./session-state"
import { getLogger } from "../lib/logger"

const log = getLogger("api")

const [worktreesByInstance, setWorktreesByInstance] = createSignal<Map<string, WorktreeDescriptor[]>>(new Map())
const [worktreeMapByInstance, setWorktreeMapByInstance] = createSignal<Map<string, WorktreeMap>>(new Map())
const [gitRepoStatusByInstance, setGitRepoStatusByInstance] = createSignal<Map<string, boolean | null>>(new Map())

const worktreeLoads = new Map<string, Promise<void>>()
const mapLoads = new Map<string, Promise<void>>()

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

async function ensureWorktreesLoaded(instanceId: string): Promise<void> {
  if (!instanceId) return
  if (worktreesByInstance().has(instanceId) && gitRepoStatusByInstance().has(instanceId)) return
  const existing = worktreeLoads.get(instanceId)
  if (existing) return existing

  const task = serverApi
    .fetchWorktrees(instanceId)
    .then((response) => {
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
    })
    .catch((error) => {
      log.warn("Failed to load worktrees", { instanceId, error })
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
    })
    .finally(() => {
      worktreeLoads.delete(instanceId)
    })

  worktreeLoads.set(instanceId, task)
  return task
}

async function reloadWorktrees(instanceId: string): Promise<void> {
  if (!instanceId) return
  await serverApi
    .fetchWorktrees(instanceId)
    .then((response) => {
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

      if (worktreeMapByInstance().has(instanceId)) {
        void pruneWorktreeMap(instanceId).catch(() => undefined)
      }
    })
    .catch((error) => {
      log.warn("Failed to reload worktrees", { instanceId, error })
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
  return await serverApi.createWorktree(instanceId, { slug: trimmed })
}

async function deleteWorktree(instanceId: string, slug: string, options?: { force?: boolean }): Promise<void> {
  if (!instanceId) {
    throw new Error("Missing instanceId")
  }
  const trimmed = (slug ?? "").trim()
  if (!trimmed || trimmed === "root") {
    throw new Error("Invalid worktree")
  }
  await serverApi.deleteWorktree(instanceId, trimmed, options)
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
  return normalizeWorktreeSlug(instanceId, getWorktreeMap(instanceId).defaultWorktreeSlug || "root")
}

async function setDefaultWorktreeSlug(instanceId: string, slug: string): Promise<void> {
  await ensureWorktreeMapLoaded(instanceId)
  const current = getWorktreeMap(instanceId)
  const nextSlug = normalizeWorktreeSlug(instanceId, slug)
  const next: WorktreeMap = { ...current, defaultWorktreeSlug: nextSlug }
  setWorktreeMapByInstance((prev) => {
    const map = new Map(prev)
    map.set(instanceId, next)
    return map
  })

  await serverApi.writeWorktreeMap(instanceId, next).catch((error) => {
    log.warn("Failed to persist default worktree", { instanceId, slug: nextSlug, error })
  })
}

function getParentSessionId(instanceId: string, sessionId: string): string {
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) return sessionId
  return session.parentId ?? session.id
}

function getWorktreeSlugForParentSession(instanceId: string, parentSessionId: string): string {
  const map = getWorktreeMap(instanceId)
  const candidate = map.parentSessionWorktreeSlug[parentSessionId] ?? map.defaultWorktreeSlug ?? "root"
  return normalizeWorktreeSlug(instanceId, candidate)
}

function getWorktreeSlugForSession(instanceId: string, sessionId: string): string {
  const parentId = getParentSessionId(instanceId, sessionId)
  return getWorktreeSlugForParentSession(instanceId, parentId)
}

async function setWorktreeSlugForParentSession(instanceId: string, parentSessionId: string, slug: string): Promise<void> {
  await ensureWorktreeMapLoaded(instanceId)
  const current = getWorktreeMap(instanceId)
  const normalizedSlug = normalizeWorktreeSlug(instanceId, slug)
  const nextMapping = { ...(current.parentSessionWorktreeSlug ?? {}) }
  nextMapping[parentSessionId] = normalizedSlug
  const next: WorktreeMap = { ...current, parentSessionWorktreeSlug: nextMapping }
  setWorktreeMapByInstance((prev) => {
    const map = new Map(prev)
    map.set(instanceId, next)
    return map
  })

  await serverApi.writeWorktreeMap(instanceId, next).catch((error) => {
    log.warn("Failed to persist session worktree mapping", { instanceId, parentSessionId, slug: normalizedSlug, error })
  })
}

async function removeParentSessionMapping(instanceId: string, parentSessionId: string): Promise<void> {
  await ensureWorktreeMapLoaded(instanceId)
  const current = getWorktreeMap(instanceId)
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
    log.warn("Failed to persist session worktree mapping removal", { instanceId, parentSessionId, error })
  })
}

function getWorktreeSlugForDirectory(instanceId: string, directory: string | undefined): string | null {
  if (!directory) return null
  const list = getWorktrees(instanceId)
  const match = list.find((wt) => wt.directory === directory)
  return match?.slug ?? null
}

function buildWorktreeProxyPath(instanceId: string, slug: string): string {
  const normalizedSlug = normalizeWorktreeSlug(instanceId, slug || "root")
  return `/workspaces/${encodeURIComponent(instanceId)}/worktrees/${encodeURIComponent(normalizedSlug)}/instance`
}

function getOrCreateWorktreeClient(instanceId: string, slug: string): OpencodeClient {
  const normalized = normalizeWorktreeSlug(instanceId, slug || "root")
  const proxyPath = buildWorktreeProxyPath(instanceId, normalized)
  return sdkManager.createClient(instanceId, proxyPath, normalized)
}

function getRootClient(instanceId: string): OpencodeClient {
  return getOrCreateWorktreeClient(instanceId, "root")
}

export {
  worktreesByInstance,
  worktreeMapByInstance,
  gitRepoStatusByInstance,
  ensureWorktreesLoaded,
  reloadWorktrees,
  reloadWorktreeMap,
  ensureWorktreeMapLoaded,
  getGitRepoStatus,
  getWorktrees,
  getWorktreeMap,
  getDefaultWorktreeSlug,
  setDefaultWorktreeSlug,
  getParentSessionId,
  getWorktreeSlugForParentSession,
  getWorktreeSlugForSession,
  setWorktreeSlugForParentSession,
  removeParentSessionMapping,
  getWorktreeSlugForDirectory,
  buildWorktreeProxyPath,
  getOrCreateWorktreeClient,
  getRootClient,
  createWorktree,
  deleteWorktree,
}
