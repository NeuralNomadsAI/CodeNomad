import type { OpenCodeClient, SessionInfo } from "@opencode-ai/client"

const PAGE_SIZE = 200
const MAX_PAGES = 10_000
const MAX_SESSIONS = 1_000_000

function normalizeDirectory(directory: string): string {
  const normalized = directory.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "/"
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
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

function familyRoot(session: SessionInfo, sessions: Map<string, SessionInfo>): SessionInfo {
  const seen = new Set([session.id])
  let current = session
  while (current.parentID) {
    if (seen.has(current.parentID)) throw new Error(`Invalid session ancestry for ${session.id}`)
    seen.add(current.parentID)
    const parent = sessions.get(current.parentID)
    if (!parent) throw new Error(`Session inventory is missing ancestor ${current.parentID}`)
    current = parent
  }
  return current
}

export async function evacuateWorktreeSessions(params: {
  client: OpenCodeClient
  projectDirectory: string
  targetDirectory: string
  rootDirectory: string
}): Promise<void> {
  const target = normalizeDirectory(params.targetDirectory)
  const project = (await params.client.project.list()).find((candidate) => (
    normalizeDirectory(candidate.canonical) === normalizeDirectory(params.projectDirectory)
    || candidate.sandboxes.some((directory) => normalizeDirectory(directory) === target)
  ))
  if (!project) throw new Error("Unable to resolve the OpenCode project before deleting worktree")
  const sessions = await inventorySessions(params.client, project.id)
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const roots = new Map<string, SessionInfo>()

  for (const session of sessions) {
    if (normalizeDirectory(session.location.directory) !== target) continue
    const root = familyRoot(session, byId)
    roots.set(root.id, root)
  }

  const moved: SessionInfo[] = []
  try {
    for (const root of roots.values()) {
      moved.push(root)
      await params.client.session.move({ sessionID: root.id, directory: params.rootDirectory })
    }

    const remaining = (await inventorySessions(params.client, project.id))
      .filter((session) => normalizeDirectory(session.location.directory) === target)
    if (remaining.length) throw new Error(`Worktree still contains ${remaining.length} session(s) after evacuation`)
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const root of moved.reverse()) {
      try {
        await params.client.session.move({ sessionID: root.id, directory: root.location.directory })
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], "Session evacuation failed and could not be rolled back")
    }
    throw error
  }
}
