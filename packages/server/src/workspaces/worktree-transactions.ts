import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { WorktreeDescriptor, WorktreeSessionLocation, WorktreeSessionMoveResponse } from "../api-types"
import type { OpencodeYoloPersistence } from "../permissions/opencode-yolo-metadata"
import { isRegisteredWorktree, removeWorktree, type LogLike } from "./git-worktrees"

const SESSION_LIMIT = 10_000

type NativeSession = {
  id: string
  parentID?: string
  directory?: string
  workspaceID?: string
  metadata?: unknown
}
type NativeWorkspace = { id: string; directory?: string | null }
type NativeState = {
  client: OpencodeClient
  rootDirectory: string
  sessions: NativeSession[]
  workspaces: NativeWorkspace[]
  statuses: Record<string, unknown>
}

export class WorktreeSessionBusyError extends Error {}
export class WorktreeRollbackIncompleteError extends AggregateError {}

function sameDirectory(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "")
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

async function listSessions(state: NativeState): Promise<NativeSession[]> {
  const { data = [] } = await state.client.session.list(
    { scope: "project", limit: SESSION_LIMIT, directory: state.rootDirectory } as any,
    { throwOnError: true },
  )
  if (data.length >= SESSION_LIMIT) throw new Error("Unable to verify the complete project session inventory")
  state.sessions = data as NativeSession[]
  return state.sessions
}

export async function loadNativeState(client: OpencodeClient, rootDirectory: string): Promise<NativeState> {
  const scope = { directory: rootDirectory }
  await client.experimental.workspace.syncList(scope, { throwOnError: true })
  const state: NativeState = { client, rootDirectory, sessions: [], workspaces: [], statuses: {} }
  const [{ data: workspaces = [] }] = await Promise.all([
    client.experimental.workspace.list(scope, { throwOnError: true }),
    listSessions(state),
  ])
  state.workspaces = workspaces as NativeWorkspace[]
  const status = await Promise.all([
    client.session.status(scope, { throwOnError: true }),
    ...state.workspaces.map((workspace) => client.session.status({ ...scope, workspace: workspace.id }, { throwOnError: true })),
  ])
  state.statuses = Object.assign({}, ...status.map(({ data = {} }) => data))
  return state
}

function rootFor(session: NativeSession, byId: Map<string, NativeSession>): NativeSession {
  let current = session
  const seen = new Set([session.id])
  while (current.parentID) {
    const parent = byId.get(current.parentID)
    if (!parent || seen.has(parent.id)) throw new Error(`Unable to verify the complete family for session ${session.id}`)
    seen.add(parent.id)
    current = parent
  }
  return current
}

export function completeFamily(state: Pick<NativeState, "sessions">, sessionId: string) {
  const byId = new Map(state.sessions.map((session) => [session.id, session]))
  const selected = byId.get(sessionId)
  if (!selected) throw new Error("Session not found")
  const root = rootFor(selected, byId)
  return { root, members: state.sessions.filter((session) => rootFor(session, byId).id === root.id) }
}

function statusType(status: unknown): string | undefined {
  if (typeof status === "string") return status
  if (!status || typeof status !== "object") return undefined
  const type = (status as Record<string, unknown>).type
  return typeof type === "string" ? type : undefined
}

export function assertMovable(state: Pick<NativeState, "statuses">, sessions: NativeSession[]): void {
  const busy = sessions.filter((session) => {
    const type = statusType(state.statuses[session.id])
    return Boolean(type && type !== "idle")
  })
  if (busy.length) throw new WorktreeSessionBusyError(`Busy sessions: ${busy.map((session) => session.id).join(", ")}`)
}

function location(state: NativeState, session: NativeSession): WorktreeSessionLocation {
  if (session.workspaceID) {
    const workspace = state.workspaces.find((candidate) => candidate.id === session.workspaceID)
    if (!workspace?.directory) throw new Error(`Native workspace ${session.workspaceID} is unavailable`)
    return { sessionId: session.id, workspaceId: workspace.id, directory: workspace.directory }
  }
  if (!session.directory || !sameDirectory(session.directory, state.rootDirectory)) {
    throw new Error(`Session ${session.id} location is unresolved`)
  }
  return { sessionId: session.id, workspaceId: null, directory: state.rootDirectory }
}

function targetLocation(state: NativeState, target: WorktreeDescriptor): Omit<WorktreeSessionLocation, "sessionId"> {
  const directory = target.nativeDirectory ?? target.directory
  if (target.slug === "root" || target.kind === "root") return { workspaceId: null, directory: state.rootDirectory }
  const workspace = state.workspaces.find((candidate) => sameDirectory(candidate.directory, directory))
  if (!workspace) throw new Error(`OpenCode workspace not found for worktree ${target.slug}`)
  return { workspaceId: workspace.id, directory }
}

async function moveOne(state: NativeState, desired: WorktreeSessionLocation, signal?: AbortSignal): Promise<void> {
  let failure: unknown
  await state.client.experimental.controlPlane.moveSession(
    { sessionID: desired.sessionId, destination: { directory: desired.directory } },
    { throwOnError: true, signal },
  ).catch((error) => { failure = error })
  const actual = (await listSessions(state)).find((session) => session.id === desired.sessionId)
  const reconciled = actual && location(state, actual)
  if (reconciled && reconciled.workspaceId === desired.workspaceId && sameDirectory(reconciled.directory, desired.directory)) return
  throw failure ?? new Error(`Session ${desired.sessionId} did not reach its requested location`)
}

async function moveSessions(
  state: NativeState,
  sessions: NativeSession[],
  target: Omit<WorktreeSessionLocation, "sessionId">,
  signal?: AbortSignal,
) {
  const originals = new Map(sessions.map((session) => [session.id, location(state, session)]))
  const moved: string[] = []
  const rollback = async () => {
    const failures: unknown[] = []
    for (const sessionId of [...moved].reverse()) {
      await moveOne(state, originals.get(sessionId)!, undefined).catch((error) => failures.push(error))
    }
    if (failures.length) throw new AggregateError(failures, "Failed to restore session locations")
  }
  try {
    for (const session of sessions) {
      signal?.throwIfAborted()
      const desired = { sessionId: session.id, ...target }
      const current = location(state, state.sessions.find((candidate) => candidate.id === session.id) ?? session)
      if (current.workspaceId === desired.workspaceId && sameDirectory(current.directory, desired.directory)) continue
      moved.push(session.id)
      await moveOne(state, desired, signal)
    }
    return { locations: sessions.map((session) => ({ sessionId: session.id, ...target })), rollback }
  } catch (error) {
    try {
      await rollback()
    } catch (rollbackError) {
      throw new WorktreeRollbackIncompleteError([error, rollbackError], "Session move failed and rollback was incomplete")
    }
    throw error
  }
}

export async function moveSessionFamily(params: {
  instanceId: string
  client: OpencodeClient
  rootDirectory: string
  sessionId: string
  target: WorktreeDescriptor
  persistence: OpencodeYoloPersistence
  signal?: AbortSignal
}): Promise<WorktreeSessionMoveResponse> {
  const state = await loadNativeState(params.client, params.rootDirectory)
  const family = completeFamily(state, params.sessionId)
  assertMovable(state, family.members)
  const moved = await moveSessions(state, family.members, targetLocation(state, params.target), params.signal)
  try {
    await params.persistence.setWorktreeSlug(params.instanceId, family.root.id, null)
  } catch (error) {
    try {
      await moved.rollback()
    } catch (rollbackError) {
      throw new WorktreeRollbackIncompleteError([error, rollbackError], "Legacy cleanup failed and rollback was incomplete")
    }
    throw error
  }
  return { rootSessionId: family.root.id, worktreeSlug: params.target.slug, sessions: moved.locations }
}

export async function deleteWorktreeTransaction(params: {
  instanceId: string
  client: OpencodeClient
  rootDirectory: string
  workspaceFolder: string
  target: WorktreeDescriptor
  force?: boolean
  persistence: OpencodeYoloPersistence
  logger?: LogLike
  signal?: AbortSignal
}): Promise<void> {
  const state = await loadNativeState(params.client, params.rootDirectory)
  const target = targetLocation(state, params.target)
  const byId = new Map(state.sessions.map((session) => [session.id, session]))
  const selected = state.sessions.filter((session) => {
    const current = location(state, session)
    return current.workspaceId === target.workspaceId && sameDirectory(current.directory, target.directory)
  })
  const roots = new Set(selected.map((session) => rootFor(session, byId).id))
  const families = state.sessions.filter((session) => roots.has(rootFor(session, byId).id))
  assertMovable(state, families)
  const moved = await moveSessions(state, families, { workspaceId: null, directory: state.rootDirectory }, params.signal)
  try {
    await removeWorktree({
      workspaceFolder: params.workspaceFolder,
      directory: params.target.directory,
      force: params.force,
      logger: params.logger,
    })
  } catch (error) {
    const stillRegistered = await isRegisteredWorktree(params.workspaceFolder, params.target.directory).catch(() => true)
    if (!stillRegistered) {
      params.logger?.warn?.({ error, directory: params.target.directory }, "Git reported an error after removing the worktree")
    } else {
    try {
      await moved.rollback()
    } catch (rollbackError) {
      throw new WorktreeRollbackIncompleteError([error, rollbackError], "Worktree deletion failed and rollback was incomplete")
    }
    throw error
    }
  }
  for (const rootId of roots) {
    await params.persistence.setWorktreeSlug(params.instanceId, rootId, null).catch((error) => {
      params.logger?.warn?.({ error, sessionId: rootId }, "Failed to clear deleted worktree metadata")
    })
  }
  if (target.workspaceId) {
    await state.client.experimental.workspace.remove(
      { directory: state.rootDirectory, id: target.workspaceId },
      { throwOnError: true },
    ).catch((error) => params.logger?.warn?.({ error }, "Failed to remove deleted native workspace"))
  }
}
