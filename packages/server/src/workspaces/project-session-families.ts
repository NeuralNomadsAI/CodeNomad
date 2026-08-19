import path from "node:path"
import type { LocationGetOutput, LocationRef, OpenCodeClient, SessionInfo } from "@opencode-ai/client"

const SESSION_PAGE_LIMIT = 500
const MAX_SESSION_PAGES = 1000
const MOVE_VERIFY_ATTEMPTS = 100
const MOVE_VERIFY_DELAY_MS = 50
const projectLocks = new Map<string, Promise<void>>()

export class ProjectSessionError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
    this.name = "ProjectSessionError"
  }
}

export interface SessionFamilyMoveResult {
  rootSessionId: string
  sessionIds: string[]
}

interface ProjectContext {
  client: OpenCodeClient
  project: LocationGetOutput["project"]
}

export async function listCompleteProjectSessions(
  client: OpenCodeClient,
  projectID: string,
): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  let page = 0
  do {
    if (++page > MAX_SESSION_PAGES) throw new ProjectSessionError("Session inventory exceeded the page limit", 502)
    const response = await client.session.list({ project: projectID, limit: SESSION_PAGE_LIMIT, cursor })
    if (!response || !Array.isArray(response.data) || !response.cursor || typeof response.cursor !== "object") {
      throw new ProjectSessionError("OpenCode returned an invalid session inventory", 502)
    }
    for (const session of response.data) {
      if (!session?.id || session.projectID !== projectID || !session.location?.directory) {
        throw new ProjectSessionError("OpenCode returned a session outside the requested project", 409)
      }
      sessions.push(session)
    }

    const rawNext = response.cursor.next
    if (rawNext !== undefined && (typeof rawNext !== "string" || !rawNext.trim())) {
      throw new ProjectSessionError("OpenCode returned an invalid session inventory cursor", 502)
    }
    const next = rawNext
    if (next && cursors.has(next)) throw new ProjectSessionError(`Session inventory repeated cursor: ${next}`, 502)
    if (next) cursors.add(next)
    cursor = next
  } while (cursor)

  return sessions
}

export function resolveSessionFamilies(sessions: SessionInfo[]): Map<string, SessionInfo[]> {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  if (byId.size !== sessions.length) throw new ProjectSessionError("Session inventory contains duplicate sessions", 409)
  const rootById = new Map<string, string>()

  const rootFor = (session: SessionInfo): string => {
    const cached = rootById.get(session.id)
    if (cached) return cached
    const chain: SessionInfo[] = []
    const seen = new Set<string>()
    let current = session
    while (current.parentID) {
      if (seen.has(current.id)) throw new ProjectSessionError(`Session family contains a cycle at: ${current.id}`, 409)
      seen.add(current.id)
      chain.push(current)
      const parent = byId.get(current.parentID)
      if (!parent) throw new ProjectSessionError(`Session family is incomplete; missing parent: ${current.parentID}`, 409)
      current = parent
    }
    if (seen.has(current.id)) throw new ProjectSessionError(`Session family contains a cycle at: ${current.id}`, 409)
    rootById.set(current.id, current.id)
    for (const member of chain) rootById.set(member.id, current.id)
    return current.id
  }

  const families = new Map<string, SessionInfo[]>()
  for (const session of sessions) {
    const root = rootFor(session)
    const family = families.get(root) ?? []
    family.push(session)
    families.set(root, family)
  }
  for (const family of families.values()) {
    family.sort((left, right) => ancestryDepth(left, byId) - ancestryDepth(right, byId))
  }
  return families
}

export async function moveProjectSessionFamily(params: {
  client: OpenCodeClient
  projectDirectory: string
  sessionId: string
  targetDirectory: string
  validateTarget?: () => Promise<boolean>
}): Promise<SessionFamilyMoveResult> {
  return withProject(params.client, params.projectDirectory, async (context) => {
    if (params.validateTarget && !await params.validateTarget()) {
      throw new ProjectSessionError("Worktree changed before the session move", 409)
    }
    const inventory = await listCompleteProjectSessions(context.client, context.project.id)
    const families = resolveSessionFamilies(inventory)
    const family = Array.from(families.entries()).find(([, members]) => members.some(({ id }) => id === params.sessionId))
    if (!family) throw new ProjectSessionError("Session not found in project", 404)
    await assertInactive(context.client, family[1])
    if (params.validateTarget && !await params.validateTarget()) {
      throw new ProjectSessionError("Worktree changed before the session move", 409)
    }
    const target = await resolveProjectLocation(context, params.targetDirectory)
    await moveWithRollback(context, family[1], target)
    return { rootSessionId: family[0], sessionIds: family[1].map(({ id }) => id) }
  })
}

export async function removeProjectWorktree(params: {
  client: OpenCodeClient
  projectDirectory: string
  targetDirectory: string
  rootDirectory: string
  remove: () => Promise<void>
  isTargetRegistered: () => Promise<boolean>
}): Promise<void> {
  await withProject(params.client, params.projectDirectory, async (context) => {
    if (!await params.isTargetRegistered()) {
      throw new ProjectSessionError("Worktree changed before deletion", 409)
    }
    const inventory = await listCompleteProjectSessions(context.client, context.project.id)
    const families = Array.from(resolveSessionFamilies(inventory).values())
      .filter((family) => family.some((session) => directoryContains(params.targetDirectory, session.location.directory)))
    await assertInactive(context.client, families.flat())
    const original = new Map(families.flat().map((session) => [session.id, session.location]))
    const moved: string[] = []
    let root: LocationRef | undefined

    try {
      if (families.length) {
        const destination = await resolveProjectLocation(context, params.rootDirectory)
        root = destination
        for (const family of families) await moveMembers(context, family, destination, moved)
        await verifyInventory(context, moved, new Map(moved.map((id) => [id, destination])))
        const refreshed = await listCompleteProjectSessions(context.client, context.project.id)
        if (refreshed.some((session) => directoryContains(params.targetDirectory, session.location.directory))) {
          throw new ProjectSessionError("Sessions remain attached to the worktree after evacuation", 409)
        }
      }
      await assertInactive(context.client, families.flat())
      await params.remove()
    } catch (error) {
      const changed = root ? await refreshChangedSessionIds(context, moved, root) : []
      if (changed.length) {
        let registered: boolean
        try {
          registered = await params.isTargetRegistered()
        } catch (inventoryError) {
          throw new ProjectSessionError(
            `${errorMessage(error)}; unable to verify worktree registration, rollback skipped: ${errorMessage(inventoryError)}`,
            500,
          )
        }
        // A mismatched identity may now be a replacement checkout; never move sessions into it.
        if (registered) await rollback(context, changed, original, error)
      }
      throw asProjectError(error, "Unable to remove worktree")
    }
  })
}

async function withProject<T>(
  client: OpenCodeClient,
  directory: string,
  operation: (context: ProjectContext) => Promise<T>,
): Promise<T> {
  let location: LocationGetOutput
  try {
    location = await client.location.get({ location: { directory } })
  } catch (error) {
    throw asProjectError(error, "Unable to resolve the workspace project")
  }
  if (!location?.project?.id) throw new ProjectSessionError("OpenCode could not resolve the workspace project", 502)
  const previous = projectLocks.get(location.project.id) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(async () => {
    try {
      return await operation({ client, project: location.project })
    } catch (error) {
      throw asProjectError(error, "Project session operation failed")
    }
  })
  const tail = run.then(() => undefined, () => undefined)
  projectLocks.set(location.project.id, tail)
  try {
    return await run
  } finally {
    if (projectLocks.get(location.project.id) === tail) projectLocks.delete(location.project.id)
  }
}

async function resolveProjectLocation(context: ProjectContext, directory: string): Promise<LocationRef> {
  const location = await context.client.location.get({ location: { directory } })
  if (!location?.directory || location.project?.id !== context.project.id) {
    throw new ProjectSessionError("Target worktree does not belong to the workspace project", 409)
  }
  return { directory: location.directory, workspaceID: location.workspaceID }
}

async function assertInactive(client: OpenCodeClient, sessions: SessionInfo[]): Promise<void> {
  if (!sessions.length) return
  const active = await client.session.active()
  const blockers = sessions.filter(({ id }) => Object.prototype.hasOwnProperty.call(active, id)).map(({ id }) => id)
  if (blockers.length) throw new ProjectSessionError(`Active sessions block this operation: ${blockers.join(", ")}`, 409)
}

async function moveWithRollback(context: ProjectContext, family: SessionInfo[], target: LocationRef): Promise<void> {
  const original = new Map(family.map((session) => [session.id, session.location]))
  const moved: string[] = []
  try {
    await moveMembers(context, family, target, moved)
    const refreshed = await verifyInventory(context, moved, new Map(moved.map((id) => [id, target])))
    const refreshedFamily = resolveSessionFamilies(refreshed).get(family[0]!.id)
    if (!refreshedFamily
      || !family.every(({ id }) => refreshedFamily.some((session) => session.id === id))
      || !refreshedFamily.every((session) => sameLocation(session.location, target))) {
      throw new ProjectSessionError("Session family changed during the move", 409)
    }
  } catch (error) {
    const changed = await refreshChangedSessionIds(context, family.map(({ id }) => id), target)
    await rollback(context, changed, original, error)
    throw asProjectError(error, "Unable to move session family")
  }
}

async function moveMembers(
  context: ProjectContext,
  members: SessionInfo[],
  target: LocationRef,
  moved: string[],
): Promise<void> {
  for (const session of members) {
    await assertInactive(context.client, [session])
    moved.push(session.id)
    await context.client.session.move({
      sessionID: session.id,
      directory: target.directory,
      workspaceID: target.workspaceID,
    })
    await waitForSessionLocation(context, session.id, target, `Session move verification failed: ${session.id}`)
  }
}

async function refreshChangedSessionIds(
  context: ProjectContext,
  candidates: string[],
  transactionLocation: LocationRef,
): Promise<string[]> {
  try {
    const refreshed = new Map((await listCompleteProjectSessions(context.client, context.project.id)).map((session) => [session.id, session]))
    return candidates.filter((id) => {
      const session = refreshed.get(id)
      return Boolean(session && sameLocation(session.location, transactionLocation))
    })
  } catch {
    const changed: string[] = []
    for (const id of candidates) {
      try {
        const session = await context.client.session.get({ sessionID: id })
        if (session.id !== id || session.projectID !== context.project.id) {
          throw new ProjectSessionError(`OpenCode returned the wrong session while determining rollback state: ${id}`, 502)
        }
        if (sameLocation(session.location, transactionLocation)) {
          changed.push(id)
        }
      } catch (error) {
        throw new ProjectSessionError(`Unable to determine rollback state for ${id}: ${errorMessage(error)}`, 500)
      }
    }
    return changed
  }
}

async function rollback(
  context: ProjectContext,
  moved: string[],
  original: Map<string, LocationRef>,
  cause: unknown,
): Promise<void> {
  try {
    for (const sessionId of [...moved].reverse()) {
      const location = original.get(sessionId)!
      await context.client.session.move({ sessionID: sessionId, directory: location.directory, workspaceID: location.workspaceID })
      await waitForSessionLocation(context, sessionId, location, `Session rollback verification failed: ${sessionId}`)
    }
    await verifyInventory(context, moved, original)
  } catch (rollbackError) {
    throw new ProjectSessionError(
      `${errorMessage(cause)}; rollback failed: ${errorMessage(rollbackError)}`,
      500,
    )
  }
}

async function verifyInventory(
  context: ProjectContext,
  sessionIds: string[],
  expected: Map<string, LocationRef>,
): Promise<SessionInfo[]> {
  for (let attempt = 0; attempt < MOVE_VERIFY_ATTEMPTS; attempt += 1) {
    const sessions = await listCompleteProjectSessions(context.client, context.project.id)
    const refreshed = new Map(sessions.map((session) => [session.id, session]))
    if (sessionIds.every((sessionId) => {
      const session = refreshed.get(sessionId)
      return Boolean(session && sameLocation(session.location, expected.get(sessionId)!))
    })) return sessions
    await new Promise((resolve) => setTimeout(resolve, MOVE_VERIFY_DELAY_MS))
  }
  throw new ProjectSessionError("Timed out waiting for session inventory verification", 409)
}

async function waitForSessionLocation(
  context: ProjectContext,
  sessionId: string,
  expected: LocationRef,
  message: string,
): Promise<SessionInfo> {
  for (let attempt = 0; attempt < MOVE_VERIFY_ATTEMPTS; attempt += 1) {
    const session = await context.client.session.get({ sessionID: sessionId })
    if (session.id !== sessionId || session.projectID !== context.project.id) {
      throw new ProjectSessionError(`OpenCode returned the wrong session after move: ${sessionId}`, 502)
    }
    if (sameLocation(session.location, expected)) return session
    await new Promise((resolve) => setTimeout(resolve, MOVE_VERIFY_DELAY_MS))
  }
  throw new ProjectSessionError(message, 409)
}

function sameLocation(left: LocationRef, right: LocationRef): boolean {
  return sameDirectory(left.directory, right.directory) && left.workspaceID === right.workspaceID
}

function ancestryDepth(session: SessionInfo, byId: Map<string, SessionInfo>): number {
  let depth = 0
  let current = session
  while (current.parentID) {
    current = byId.get(current.parentID)!
    depth += 1
  }
  return depth
}

function sameDirectory(left: string, right: string): boolean {
  const leftPath = path.resolve(left)
  const rightPath = path.resolve(right)
  return process.platform === "win32" ? leftPath.toLowerCase() === rightPath.toLowerCase() : leftPath === rightPath
}

function directoryContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function asProjectError(error: unknown, fallback: string): ProjectSessionError {
  if (error instanceof ProjectSessionError) return error
  return new ProjectSessionError(error instanceof Error ? error.message : fallback, 502)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
