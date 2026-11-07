import { createSignal } from "solid-js"
import type { WorktreeDescriptor } from "../../../server/src/api-types"
import { backendOf } from "../lib/backend-client"
import { backendEvents as serverEvents } from "../lib/server-events"
import { captureBackendOperation } from "../lib/backend-operation"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import { getSessionRoot, sessions } from "./session-state"
import { getLogger } from "../lib/logger"
import type { WorktreeReadyEvent } from "../lib/sse-manager"
import { showToastNotification } from "../lib/notifications"
import { tGlobal } from "../lib/i18n"
import { normalizeSessionDirectory } from "./session-list-options"
import { prioritizedRead } from "../lib/prioritized-read"
import { activeInstanceId, instances } from "./instances"
import type { Instance } from "../types/instance"

const log = getLogger("api")

const [worktreesByInstance, setWorktreesByInstance] = createSignal<Map<string, WorktreeDescriptor[]>>(new Map())
const [gitRepoStatusByInstance, setGitRepoStatusByInstance] = createSignal<Map<string, boolean | null>>(new Map())

const worktreeRequests = new Map<string, Promise<void>>()
const pendingWorktreeRefreshes = new Set<string>()
const freshWorktreeRequests = new Map<string, Promise<void>>()
const worktreeReads = new Map<string, Promise<void>>()
const worktreeTaskOwners = new WeakMap<Promise<void>, () => boolean>()
const worktreeOwners = new WeakMap<Promise<void>, { client: Instance["client"] | undefined; folder: string | undefined; signal?: AbortSignal; current: () => boolean }>()
const worktreeReadyRefreshes = new Map<string, Promise<void>>()
const familyMoveRequests = new Map<string, Promise<void>>()
const unreconciledFamilyMoves = new Map<string, { instanceId: string; directories: string[]; settled: boolean; request: Promise<void> }>()
const [pendingFamilyMoveSlugs, setPendingFamilyMoveSlugs] = createSignal(new Map<string, string>())
const defaultDirectories = new Map<string, string>()

function captureWorktreeOperation(instanceId: string, parent?: AbortSignal) {
  const instance = instances().get(instanceId)
  const generation = getOpenCodeInstanceGeneration(instanceId)
  return captureBackendOperation(instanceId, parent, () => instances().get(instanceId)?.client === instance?.client
    && instances().get(instanceId)?.folder === instance?.folder && getOpenCodeInstanceGeneration(instanceId) === generation)
}

type WorktreeReadyRefresh = (instanceId: string) => Promise<void>

async function queueWorktreeRequest(instanceId: string, initial: boolean, fresh = false, signal = serverEvents.signalForInstance(instanceId)): Promise<void> {
  const ownerSignal = signal
  const operation = captureWorktreeOperation(instanceId, signal)
  signal = operation.signal
  if (signal?.aborted) return
  const instance = instances().get(instanceId)
  let ownedRead: Promise<void> | undefined
  const current = () => operation.current() && instances().get(instanceId)?.client === instance?.client
    && instances().get(instanceId)?.folder === instance?.folder
  const requests = fresh ? freshWorktreeRequests : worktreeRequests
  const existing = requests.get(instanceId)
  const owner = existing && worktreeOwners.get(existing)
  if (existing && owner?.current() && owner.client === instance?.client && owner.folder === instance?.folder && owner.signal === ownerSignal) {
    if (!initial && !fresh) pendingWorktreeRefreshes.add(instanceId)
    return existing
  }
  const load = (initialRead: boolean) => {
    // Display and required-fresh callers have independent outcomes, but every
    // read/publication shares one lane. An older cached response cannot land last.
    const pending = worktreeReads.get(instanceId)
    const previous = pending && worktreeTaskOwners.get(pending)?.() ? pending : undefined
    const read = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
      if (!current()) return
      try {
        const response = await prioritizedRead(
          () => activeInstanceId() === instanceId,
          signal ?? new AbortController().signal,
          () => { signal?.throwIfAborted(); return backendOf(instanceId).api.fetchWorktrees(instanceId, fresh, signal) },
        )
        if (!current()) return
        if (response.defaultDirectory) defaultDirectories.set(instanceId, response.defaultDirectory)
        else defaultDirectories.delete(instanceId)
        setWorktreesByInstance((prev) => {
          const next = new Map(prev)
          next.set(instanceId, response.worktrees ?? [])
          return next
        })
        if (!current()) return

        setGitRepoStatusByInstance((prev) => {
          const next = new Map(prev)
          next.set(instanceId, typeof response.isGitRepo === "boolean" ? response.isGitRepo : null)
          return next
        })
      } catch (error) {
        if (!current()) {
          if (!signal?.aborted && (!initialRead || fresh)) throw error
          return
        }
        log.warn(initialRead ? "Failed to load worktrees" : "Failed to reload worktrees", { instanceId, error })
        if (!initialRead || fresh) throw error
        // A fresh read may have published while this initial display read waited.
        if (worktreesByInstance().has(instanceId)) return

        setWorktreesByInstance((prev) => {
          const next = new Map(prev)
          next.set(instanceId, [])
          return next
        })
        if (!current()) return

        // Preserve any previous value; if unknown, keep it unknown.
        setGitRepoStatusByInstance((prev) => {
          if (prev.has(instanceId)) return prev
          const next = new Map(prev)
          next.set(instanceId, null)
          return next
        })
      }
    })
    worktreeReads.set(instanceId, read)
    worktreeTaskOwners.set(read, current)
    ownedRead = read
    return read.finally(() => {
      if (worktreeReads.get(instanceId) === read) worktreeReads.delete(instanceId)
    })
  }
  // Like the provider/model catalogue, retain one in-flight read and one dirty
  // bit for display demand. Concurrent fresh callers share only their fresh read;
  // its failure must neither satisfy fresh recovery nor discard display demand.
  const task = Promise.resolve().then(async () => {
    let initialRead = initial
    do {
      if (!current()) return
      if (!fresh) pendingWorktreeRefreshes.delete(instanceId)
      try {
        await load(initialRead)
        if (!current()) return
      } catch (error) {
        if (fresh || !pendingWorktreeRefreshes.has(instanceId)) throw error
      }
      initialRead = false
    } while (!fresh && pendingWorktreeRefreshes.has(instanceId))
  })

  requests.set(instanceId, task)
  worktreeOwners.set(task, { client: instance?.client, folder: instance?.folder, signal: ownerSignal, current })
  const abort = () => {
    if (requests.get(instanceId) === task) {
      requests.delete(instanceId)
      pendingWorktreeRefreshes.delete(instanceId)
    }
    if (worktreeReads.get(instanceId) === ownedRead) worktreeReads.delete(instanceId)
  }
  signal?.addEventListener("abort", abort, { once: true })
  await task.finally(() => {
    signal?.removeEventListener("abort", abort)
    if (requests.get(instanceId) === task) {
      requests.delete(instanceId)
    }
  })
}

async function ensureWorktreesLoaded(instanceId: string, signal = serverEvents.signalForInstance(instanceId)): Promise<void> {
  if (!instanceId) return
  const operation = captureWorktreeOperation(instanceId, signal)
  if (!operation.current()) return
  if (worktreesByInstance().has(instanceId) && gitRepoStatusByInstance().has(instanceId)) return

  const existing = worktreeRequests.get(instanceId)
  const owner = existing && worktreeOwners.get(existing)
  // A pre-client bootstrap remains a prerequisite on this attachment; only a
  // current read can publish its inventory, and a successful stale read is reread.
  if (existing && owner?.signal === signal && (owner.current() || (!owner.client && !owner.folder))) {
    await existing
    if (!operation.current()) return
    if (worktreesByInstance().has(instanceId) && gitRepoStatusByInstance().has(instanceId)) return
  }

  if (!operation.current()) return
  await queueWorktreeRequest(instanceId, true, false, signal)
}

async function reloadWorktrees(instanceId: string, fresh = false, signal?: AbortSignal): Promise<void> {
  if (!instanceId) return
  await queueWorktreeRequest(instanceId, false, fresh, signal)
}

serverEvents.on("workspace.worktreesChanged", (event) => {
  if (event.type !== "workspace.worktreesChanged") return
  const id = event.workspaceId
  // Refresh consumers that already requested this inventory. Queue behind an
  // older HTTP response so it cannot overwrite the completed background scan.
  if (!worktreesByInstance().has(id) && !worktreeRequests.has(id) && !freshWorktreeRequests.has(id)) return
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
    directory: event.location?.directory,
    name: event.data?.name,
  })

  const pending = worktreeReadyRefreshes.get(instanceId)
  const previous = pending && worktreeTaskOwners.get(pending)?.() ? pending : undefined
  const operation = captureWorktreeOperation(instanceId)
  const task = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    if (!operation.current()) return
    if (refreshWorktrees === reloadWorktrees) await reloadWorktrees(instanceId, false, operation.signal)
    else await refreshWorktrees(instanceId)
  })

  worktreeReadyRefreshes.set(instanceId, task)
  worktreeTaskOwners.set(task, operation.current)
  await task.finally(() => {
    if (worktreeReadyRefreshes.get(instanceId) === task) {
      worktreeReadyRefreshes.delete(instanceId)
    }
  })
}

function getGitRepoStatus(instanceId: string): boolean | null {
  return gitRepoStatusByInstance().get(instanceId) ?? null
}

export function getDirectoryOnlyWorktree(instanceId: string): WorktreeDescriptor | undefined {
  return getWorktrees(instanceId).find(worktree => worktree.slug === "root" && worktree.directoryOnly)
}

async function createWorktree(instanceId: string, slug: string, fromSlug = "root"): Promise<{ slug: string; directory: string; branch?: string }> {
  const operation = captureWorktreeOperation(instanceId)
  operation.signal.throwIfAborted()
  if (!operation.current()) throw new Error("Worktree creation was superseded")
  if (!instanceId) {
    throw new Error("Missing instanceId")
  }
  const trimmed = (slug ?? "").trim()
  if (!trimmed) {
    throw new Error("Worktree name is required")
  }
  return backendOf(instanceId).api.createWorktree(instanceId, { slug: trimmed, fromSlug })
}

async function deleteWorktree(
  instanceId: string,
  slug: string,
  options?: { force?: boolean },
  refreshSessions?: (instanceId: string) => Promise<void>,
): Promise<void> {
  const operation = captureWorktreeOperation(instanceId)
  operation.signal.throwIfAborted()
  if (!operation.current()) return
  if (!instanceId) {
    throw new Error("Missing instanceId")
  }
  const trimmed = (slug ?? "").trim()
  if (!trimmed || trimmed === "root") {
    throw new Error("Invalid worktree")
  }
  let deleteError: unknown
  try {
    await backendOf(instanceId).api.deleteWorktree(instanceId, trimmed, options)
  } catch (error) {
    deleteError = error
  }
  if (!operation.current()) { if (deleteError) throw deleteError; return }
  const refreshers = [() => reloadWorktrees(instanceId, false, operation.signal), async () => {
    if (refreshSessions) return refreshSessions(instanceId)
    const { fetchSessions } = await import("./session-api")
    if (operation.current()) await fetchSessions(instanceId, { reset: true, strictStatus: true, signal: operation.signal })
  }]
  const refreshes = await Promise.allSettled(refreshers.map((refresh) => refresh()))
  const failed = refreshes.flatMap((refresh, index) => refresh.status === "rejected" ? [index] : [])
  if (operation.current() && failed.length) {
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

/** Matches a native session location against the worktree inventory. */
function getWorktreeForDirectory(instanceId: string, directory: string): WorktreeDescriptor | undefined {
  const normalized = normalizeDirectory(directory)
  return getWorktrees(instanceId).find((worktree) => normalizeDirectory(worktree.serviceDirectory ?? worktree.directory) === normalized)
}

function getWorktreeSlugForParentSession(instanceId: string, parentSessionId: string): string {
  const directory = sessions().get(instanceId)?.get(parentSessionId)?.location.directory
  const locationSlug = directory && getWorktreeForDirectory(instanceId, directory)?.slug
  if (locationSlug) return normalizeWorktreeSlug(instanceId, locationSlug)

  return "root"
}

function getWorktreeSlugForSession(instanceId: string, sessionId: string): string {
  return getWorktreeSlugForParentSession(instanceId, sessionId)
}

export function getDefaultWorktreeDirectory(instanceId: string): string | undefined {
  return defaultDirectories.get(instanceId)
}

export function getPendingWorktreeSlug(instanceId: string, sessionId: string): string | undefined {
  return pendingFamilyMoveSlugs().get(`${instanceId}:${getParentSessionId(instanceId, sessionId)}`)
}

export function getPendingWorktreeLocations(instanceId: string): Array<{ directory: string }> {
  return [...unreconciledFamilyMoves.values()].filter(move => move.instanceId === instanceId)
    .flatMap(move => move.directories.map(directory => ({ directory })))
}

export function clearPendingWorktreeMoves(instanceId: string): void {
  const keys = [...unreconciledFamilyMoves].filter(([, move]) => move.instanceId === instanceId).map(([key]) => key)
  for (const key of keys) unreconciledFamilyMoves.delete(key)
  setPendingFamilyMoveSlugs(previous => {
    const next = new Map(previous)
    for (const key of keys) next.delete(key)
    return next
  })
}

/** Only a complete owned project inventory plus fresh activity can release an
 * uncertain move's locations. Capture before I/O so an older read cannot settle
 * a newer or still-running move. Absence from that scope is authoritative too;
 * deleted or moved-away member IDs must not pin these directories forever.
 * This never retries a mutation and does not own selector busy state. */
export function captureWorktreeMoveReconciliation(instanceId: string) {
  const captured = [...unreconciledFamilyMoves].filter(([, move]) => move.instanceId === instanceId && move.settled)
  return () => {
    for (const [key, move] of captured) {
      if (unreconciledFamilyMoves.get(key) !== move || (familyMoveRequests.has(key) && familyMoveRequests.get(key) !== move.request)) continue
      unreconciledFamilyMoves.delete(key)
    }
  }
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
  const operation = captureWorktreeOperation(instanceId)
  operation.signal.throwIfAborted()
  if (!operation.current()) return
  await ensureWorktreesLoaded(instanceId, operation.signal)
  if (!operation.current()) return
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
  const pending = familyMoveRequests.get(key)
  const previous = pending && worktreeTaskOwners.get(pending)?.() ? pending : undefined
  const moveFamily = options.moveFamily ?? ((id: string, sessionId: string, worktreeSlug: string) =>
    backendOf(id).api.moveSessionFamily(id, sessionId, { worktreeSlug }))
  const refreshSessions = options.refreshSessions ?? (async (id: string) => {
    const { fetchSessions } = await import("./session-api")
    if (operation.current()) await fetchSessions(id, { reset: true, strictStatus: true, signal: operation.signal })
  })
  const task: Promise<void> = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    if (!operation.current()) return
    const family = [...(sessions().get(instanceId)?.values() ?? [])].filter(session => getParentSessionId(instanceId, session.id) === rootSessionId)
    const prior = unreconciledFamilyMoves.get(key)
    const recovery = { instanceId,
      directories: [...new Set([targetDirectory, ...family.map(session => session.location.directory), ...(prior?.directories ?? [])])], settled: false, request: task }
    unreconciledFamilyMoves.set(key, recovery)
    let moveError: unknown
    try {
      await moveFamily(instanceId, rootSessionId, normalizedSlug)
    } catch (error) {
      moveError = error
    }
    recovery.settled = true
    if (!operation.current()) { if (moveError) throw moveError; return }
    try {
      await refreshSessions(instanceId)
    } catch {
      if (operation.current()) await refreshSessions(instanceId).catch((error) => {
        log.warn("Failed to refresh sessions after family move", { instanceId, rootSessionId, error })
      })
    }
    if (moveError) {
      log.warn("Failed to move session family", { instanceId, rootSessionId, error: moveError })
      if (operation.current()) showToastNotification({ category: "files",
        message: tGlobal("sessionList.worktreeMove.error"),
        variant: "error",
      })
      throw moveError
    }
  })

  familyMoveRequests.set(key, task)
  worktreeTaskOwners.set(task, operation.current)
  setPendingFamilyMoveSlugs(previous => new Map(previous).set(key, normalizedSlug))
  const finish = () => {
    if (familyMoveRequests.get(key) !== task) return
    familyMoveRequests.delete(key)
    setPendingFamilyMoveSlugs(previous => {
      const next = new Map(previous)
      next.delete(key)
      return next
    })
  }
  operation.signal.addEventListener("abort", finish, { once: true })
  if (operation.signal.aborted) finish()
  await task.finally(() => {
    operation.signal.removeEventListener("abort", finish)
    finish()
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
  getWorktreeForDirectory,
  getWorktreeSlugForParentSession,
  getWorktreeSlugForSession,
  setWorktreeSlugForParentSession,
  createWorktree,
  deleteWorktree,
}
