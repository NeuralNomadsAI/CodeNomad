import type { OpenCodeClient, SessionInfo } from "@opencode-ai/client"
import { normalizeWslUncPath } from "./worktree-directory"

const PAGE_SIZE = 200
const MAX_PAGES = 10_000
const MAX_SESSIONS = 1_000_000
const MUTATION_DRAIN_TIMEOUT_MS = 30_000

function normalizeDirectory(directory: string): string {
  const wsl = normalizeWslUncPath(directory)
  if (wsl) return wsl
  const normalized = directory.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "/"
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
}

export class WorktreeDeletionFence {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly blocked = new Map<string, number>()
  private readonly active = new Map<string, number>()
  private readonly idleWaiters = new Map<string, Set<() => void>>()

  constructor(private readonly mutationDrainTimeoutMs = MUTATION_DRAIN_TIMEOUT_MS) {}

  isBlocked(directory: string): boolean {
    return this.blocked.has(normalizeDirectory(directory))
  }

  enter(directories: string[]): (() => void) | undefined {
    const normalized = [...new Set(directories.map(normalizeDirectory))]
    if (normalized.some((directory) => this.blocked.has(directory))) return undefined
    for (const directory of normalized) this.active.set(directory, (this.active.get(directory) ?? 0) + 1)

    let released = false
    return () => {
      if (released) return
      released = true
      for (const directory of normalized) {
        const count = this.active.get(directory) ?? 0
        if (count > 1) {
          this.active.set(directory, count - 1)
          continue
        }
        this.active.delete(directory)
        for (const resolve of this.idleWaiters.get(directory) ?? []) resolve()
        this.idleWaiters.delete(directory)
      }
    }
  }

  run<T>(key: string, directories: string[], operation: () => Promise<T>): Promise<T> {
    const normalizedKey = normalizeDirectory(key)
    const blocked = [...new Set(directories.map(normalizeDirectory))]
    for (const directory of blocked) this.blocked.set(directory, (this.blocked.get(directory) ?? 0) + 1)

    const previous = this.queues.get(normalizedKey) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      await Promise.all(blocked.map((directory) => this.waitForIdle(directory)))
      return operation()
    })
    this.queues.set(normalizedKey, current)
    return current.finally(() => {
      for (const directory of blocked) {
        const count = this.blocked.get(directory) ?? 0
        if (count > 1) this.blocked.set(directory, count - 1)
        else this.blocked.delete(directory)
      }
      if (this.queues.get(normalizedKey) === current) this.queues.delete(normalizedKey)
    })
  }

  private waitForIdle(directory: string): Promise<void> {
    if (!this.active.has(directory)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiters = this.idleWaiters.get(directory) ?? new Set()
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      waiters.add(done)
      this.idleWaiters.set(directory, waiters)
      const timer = setTimeout(() => {
        waiters.delete(done)
        if (!waiters.size) this.idleWaiters.delete(directory)
        reject(new Error("Timed out waiting for worktree mutations to finish"))
      }, this.mutationDrainTimeoutMs)
    })
  }
}

async function inventorySessions(client: OpenCodeClient, project: string): Promise<SessionInfo[]> {
  const sessions = new Map<string, SessionInfo>()
  const cursors = new Set<string>()
  let cursor: string | undefined

  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
    const page = await client.session.list(cursor ? { cursor } : { project, limit: PAGE_SIZE, order: "asc" })
    for (const session of page.data) {
      sessions.set(session.id, session)
      if (sessions.size > MAX_SESSIONS) throw new Error("Session inventory exceeded its safety limit")
    }

    cursor = page.cursor.next ?? undefined
    if (!cursor) return Array.from(sessions.values())
    if (cursors.has(cursor)) throw new Error(`Repeated session inventory cursor: ${cursor}`)
    cursors.add(cursor)
  }

  throw new Error("Session inventory exceeded its page limit")
}

async function waitForInventory(
  client: OpenCodeClient,
  project: string,
  predicate: (sessions: SessionInfo[]) => boolean | Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate(await inventorySessions(client, project))) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Timed out waiting for session moves")
}

export async function evacuateWorktreeSessions(params: {
  client: OpenCodeClient
  projectDirectory: string
  targetDirectory: string
  rootDirectory: string
  resolveDirectoryIdentity?: (directory: string) => Promise<string | undefined>
  remove: () => Promise<void>
}): Promise<void> {
  const identity = async (directory: string) => normalizeDirectory(
    await params.resolveDirectoryIdentity?.(directory) ?? directory,
  )
  const target = await identity(params.targetDirectory)
  const matchesTarget = async (directory: string) => await identity(directory) === target
  const projects = await params.client.project.list()
  let project: (typeof projects)[number] | undefined
  for (const candidate of projects) {
    if (normalizeDirectory(candidate.canonical) === normalizeDirectory(params.projectDirectory)
      || (await Promise.all(candidate.sandboxes.map(matchesTarget))).some(Boolean)) {
      project = candidate
      break
    }
  }
  if (!project) throw new Error("Unable to resolve the OpenCode project before deleting worktree")
  const sessions = await inventorySessions(params.client, project.id)
  const affected = (await Promise.all(sessions.map(async (session) => (
    await matchesTarget(session.location.directory) ? session : undefined
  )))).filter((session): session is SessionInfo => Boolean(session))
  const assertInactive = async (candidates = affected) => {
    const active = await params.client.session.active()
    const blockers = candidates.filter((session) => Object.prototype.hasOwnProperty.call(active, session.id))
    if (blockers.length) throw new Error(`Active sessions block worktree deletion: ${blockers.map((session) => session.id).join(", ")}`)
  }
  await assertInactive()

  const moved: SessionInfo[] = []
  try {
    for (const session of affected) {
      await assertInactive()
      const original = { ...session, location: { ...session.location } }
      await params.client.session.move({ sessionID: session.id, directory: params.rootDirectory })
      moved.push(original)
    }
    await waitForInventory(params.client, project.id, async (current) => (
      !(await Promise.all(current.map((session) => matchesTarget(session.location.directory)))).some(Boolean)
    ))
    const finalInventory = await inventorySessions(params.client, project.id)
    const finalAffected = (await Promise.all(finalInventory.map(async (session) => (
      await matchesTarget(session.location.directory) ? session : undefined
    )))).filter((session): session is SessionInfo => Boolean(session))
    await assertInactive(finalAffected)
    if (finalAffected.length) throw new Error("Sessions appeared in the worktree during deletion")
    await params.remove()
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const session of moved.reverse()) {
      try {
        await params.client.session.move({
          sessionID: session.id,
          directory: session.location.directory,
          workspaceID: session.location.workspaceID,
        })
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    try {
      const expected = new Set(moved.map((session) => session.id))
      await waitForInventory(params.client, project.id, async (current) => {
        const restored = current.filter((session) => expected.has(session.id))
        return restored.length === expected.size
          && (await Promise.all(restored.map((session) => matchesTarget(session.location.directory)))).every(Boolean)
      })
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], "Session evacuation failed and could not be rolled back")
    }
    throw error
  }
}
