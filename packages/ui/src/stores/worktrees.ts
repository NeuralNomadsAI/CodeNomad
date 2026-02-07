import { createSignal } from "solid-js"
import type { WorktreeDescriptor, WorktreeMap } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { sdkManager, type OpencodeClient } from "../lib/sdk-manager"
import { sessions } from "./session-state"
import { getLogger } from "../lib/logger"

const log = getLogger("api")

const [worktreesByInstance, setWorktreesByInstance] = createSignal<Map<string, WorktreeDescriptor[]>>(new Map())
const [worktreeMapByInstance, setWorktreeMapByInstance] = createSignal<Map<string, WorktreeMap>>(new Map())

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
  if (worktreesByInstance().has(instanceId)) return
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
    })
    .catch((error) => {
      log.warn("Failed to load worktrees", { instanceId, error })
      setWorktreesByInstance((prev) => {
        const next = new Map(prev)
        next.set(instanceId, [])
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
    })
    .catch((error) => {
      log.warn("Failed to reload worktrees", { instanceId, error })
    })
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

function getDefaultWorktreeSlug(instanceId: string): string {
  return getWorktreeMap(instanceId).defaultWorktreeSlug || "root"
}

async function setDefaultWorktreeSlug(instanceId: string, slug: string): Promise<void> {
  await ensureWorktreeMapLoaded(instanceId)
  const current = getWorktreeMap(instanceId)
  const next: WorktreeMap = { ...current, defaultWorktreeSlug: slug }
  setWorktreeMapByInstance((prev) => {
    const map = new Map(prev)
    map.set(instanceId, next)
    return map
  })

  await serverApi.writeWorktreeMap(instanceId, next).catch((error) => {
    log.warn("Failed to persist default worktree", { instanceId, slug, error })
  })
}

function getParentSessionId(instanceId: string, sessionId: string): string {
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!session) return sessionId
  return session.parentId ?? session.id
}

function getWorktreeSlugForParentSession(instanceId: string, parentSessionId: string): string {
  const map = getWorktreeMap(instanceId)
  return map.parentSessionWorktreeSlug[parentSessionId] ?? map.defaultWorktreeSlug ?? "root"
}

function getWorktreeSlugForSession(instanceId: string, sessionId: string): string {
  const parentId = getParentSessionId(instanceId, sessionId)
  return getWorktreeSlugForParentSession(instanceId, parentId)
}

async function setWorktreeSlugForParentSession(instanceId: string, parentSessionId: string, slug: string): Promise<void> {
  await ensureWorktreeMapLoaded(instanceId)
  const current = getWorktreeMap(instanceId)
  const nextMapping = { ...(current.parentSessionWorktreeSlug ?? {}) }
  nextMapping[parentSessionId] = slug
  const next: WorktreeMap = { ...current, parentSessionWorktreeSlug: nextMapping }
  setWorktreeMapByInstance((prev) => {
    const map = new Map(prev)
    map.set(instanceId, next)
    return map
  })

  await serverApi.writeWorktreeMap(instanceId, next).catch((error) => {
    log.warn("Failed to persist session worktree mapping", { instanceId, parentSessionId, slug, error })
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
  const normalizedSlug = slug || "root"
  return `/workspaces/${encodeURIComponent(instanceId)}/worktrees/${encodeURIComponent(normalizedSlug)}/instance`
}

function getOrCreateWorktreeClient(instanceId: string, slug: string): OpencodeClient {
  const proxyPath = buildWorktreeProxyPath(instanceId, slug)
  return sdkManager.createClient(instanceId, proxyPath, slug)
}

function getRootClient(instanceId: string): OpencodeClient {
  return getOrCreateWorktreeClient(instanceId, "root")
}

export {
  worktreesByInstance,
  worktreeMapByInstance,
  ensureWorktreesLoaded,
  reloadWorktrees,
  reloadWorktreeMap,
  ensureWorktreeMapLoaded,
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
