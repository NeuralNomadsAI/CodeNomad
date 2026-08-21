import type { OpenCodeClient, SessionInfo } from "@opencode-ai/client"

const PAGE_SIZE = 200
const MAX_PAGES = 10_000
const MAX_SESSIONS = 1_000_000

function normalizeDirectory(directory: string): string {
  const normalized = directory.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "/"
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
}

export class WorktreeDeletionFence {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly blocked = new Map<string, number>()

  isBlocked(directory: string): boolean {
    return this.blocked.has(normalizeDirectory(directory))
  }

  run<T>(key: string, directories: string[], operation: () => Promise<T>): Promise<T> {
    const normalizedKey = normalizeDirectory(key)
    const blocked = [...new Set(directories.map(normalizeDirectory))]
    for (const directory of blocked) this.blocked.set(directory, (this.blocked.get(directory) ?? 0) + 1)

    const previous = this.queues.get(normalizedKey) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
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
}

async function inventorySessions(client: OpenCodeClient, project: string): Promise<SessionInfo[]> {
  const sessions = new Map<string, SessionInfo>()
  const cursors = new Set<string>()
  let cursor: string | undefined

  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
    const page = await client.session.list({ project, limit: PAGE_SIZE, order: "asc", cursor })
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
  predicate: (sessions: SessionInfo[]) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate(await inventorySessions(client, project))) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Timed out waiting for session moves")
}

export async function evacuateWorktreeSessions(params: {
  client: OpenCodeClient
  projectDirectory: string
  targetDirectory: string
  rootDirectory: string
  remove: () => Promise<void>
}): Promise<void> {
  const target = normalizeDirectory(params.targetDirectory)
  const project = (await params.client.project.list()).find((candidate) => (
    normalizeDirectory(candidate.canonical) === normalizeDirectory(params.projectDirectory)
    || candidate.sandboxes.some((directory) => normalizeDirectory(directory) === target)
  ))
  if (!project) throw new Error("Unable to resolve the OpenCode project before deleting worktree")
  const sessions = await inventorySessions(params.client, project.id)
  const affected = sessions.filter((session) => normalizeDirectory(session.location.directory) === target)
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
    await waitForInventory(params.client, project.id, (current) => (
      current.every((session) => normalizeDirectory(session.location.directory) !== target)
    ))
    const finalAffected = (await inventorySessions(params.client, project.id))
      .filter((session) => normalizeDirectory(session.location.directory) === target)
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
      await waitForInventory(params.client, project.id, (current) => {
        const restored = current.filter((session) => expected.has(session.id))
        return restored.length === expected.size
          && restored.every((session) => normalizeDirectory(session.location.directory) === target)
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
