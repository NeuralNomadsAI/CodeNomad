import { tGlobal } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { requestData } from "../lib/opencode-api"
import type { Session } from "../types/session"
import { getRootClient } from "./opencode-client"
import { findWorktreeSlugForDirectory, workspaceDirectoriesEqual } from "./opencode-workspace-matching"
import {
  forgetOpenCodeWorkspaceIdForSession,
  getOpenCodeWorkspaceIdForWorktree,
  rememberOpenCodeWorkspaceIdForSession,
} from "./opencode-workspaces"
import { getDescendantSessions, getSessionRoot, sessions, withSession } from "./session-state"
import { getCodeNomadSessionMetadata, setSessionWorktreeSlug } from "./session-metadata"
import {
  getWorktreeSlugForSession,
  getWorktrees,
  isWorktreeDeletionInProgress,
  removeLegacyParentSessionMapping,
} from "./worktrees"

const log = getLogger("session")
const SESSION_LIST_LIMIT = 10_000
const familyMoves = new Map<string, Promise<boolean>>()

function locationError(slug: string): Error {
  return new Error(tGlobal("instanceShell.worktree.locationUnavailable", { slug }))
}

async function targetLocation(instanceId: string, slug: string) {
  const worktree = getWorktrees(instanceId).find((candidate) => candidate.slug === slug)
  if (!worktree) throw locationError(slug)
  if (slug === "root") return { worktree, workspaceId: null }
  const workspaceId = await getOpenCodeWorkspaceIdForWorktree(instanceId, slug)
  if (!workspaceId) throw locationError(slug)
  return { worktree, workspaceId }
}

async function warpSession(instanceId: string, sessionId: string, workspaceId: string | null): Promise<void> {
  const { instances } = await import("./instances")
  const instance = instances().get(instanceId)
  if (!instance?.folder) throw new Error(tGlobal("instanceShell.worktree.moveFailed"))
  await requestData(
    getRootClient(instanceId).experimental.workspace.warp({
      directory: instance.folder,
      id: workspaceId,
      sessionID: sessionId,
    }),
    "experimental.workspace.warp",
  )
}

async function listCompleteProjectSessions(instanceId: string): Promise<any[]> {
  const listed = await requestData<any[]>(
    getRootClient(instanceId).session.list({ scope: "project", limit: SESSION_LIST_LIMIT }),
    "session.list",
  )
  if (listed.length >= SESSION_LIST_LIMIT) throw new Error(tGlobal("instanceShell.worktree.moveFailed"))
  return listed
}

async function requireCompleteProjectSessionState(instanceId: string): Promise<void> {
  const listed = await listCompleteProjectSessions(instanceId)
  const instanceSessions = sessions().get(instanceId)
  if (listed.some((session) => !instanceSessions?.has(session.id))) {
    throw new Error(tGlobal("instanceShell.worktree.moveFailed"))
  }
}

async function requireCompleteFamily(instanceId: string, root: Session): Promise<Session[]> {
  const listed = await listCompleteProjectSessions(instanceId)

  const childrenByParent = new Map<string, string[]>()
  if (!listed.some((session) => session?.id === root.id)) {
    throw new Error(tGlobal("instanceShell.worktree.moveFailed"))
  }
  for (const session of listed) {
    if (!session?.parentID) continue
    const children = childrenByParent.get(session.parentID) ?? []
    children.push(session.id)
    childrenByParent.set(session.parentID, children)
  }

  const ids = [root.id]
  const seen = new Set(ids)
  for (let index = 0; index < ids.length; index += 1) {
    for (const childId of childrenByParent.get(ids[index]!) ?? []) {
      if (seen.has(childId)) continue
      seen.add(childId)
      ids.push(childId)
    }
  }
  const instanceSessions = sessions().get(instanceId)
  const listedById = new Map(listed.map((session) => [session.id, session]))
  for (const id of ids) {
    const current = instanceSessions?.get(id)
    const authoritative = listedById.get(id)
    if (!current || !authoritative) continue
    const directory = typeof authoritative.directory === "string" ? authoritative.directory : undefined
    const explicitWorkspace = authoritative.workspaceID ?? authoritative.workspaceId ?? authoritative.workspace
    let workspaceId = typeof explicitWorkspace === "string" ? explicitWorkspace : undefined
    if (directory && !workspaceId) {
      const nativeSlug = findWorktreeSlugForDirectory(getWorktrees(instanceId), directory)
      workspaceId = nativeSlug && nativeSlug !== "root"
        ? await getOpenCodeWorkspaceIdForWorktree(instanceId, nativeSlug) ?? undefined
        : undefined
    }
    withSession(instanceId, id, (session) => {
      if (directory) session.directory = directory
      if (directory || typeof explicitWorkspace === "string") session.workspaceId = workspaceId
    })
  }
  const members = ids.map((id) => sessions().get(instanceId)?.get(id))
  if (members.some((member) => !member)) throw new Error(tGlobal("instanceShell.worktree.moveFailed"))
  return members as Session[]
}

async function originalWorkspaceId(instanceId: string, session: Session): Promise<string | null> {
  if (session.workspaceId) return session.workspaceId
  const slug = findWorktreeSlugForDirectory(getWorktrees(instanceId), session.directory)
  if (slug === "root") return null
  if (!slug) throw new Error(tGlobal("instanceShell.worktree.moveFailed"))
  const workspaceId = await getOpenCodeWorkspaceIdForWorktree(instanceId, slug)
  if (!workspaceId) throw locationError(slug)
  return workspaceId
}

async function rollbackMovedMembers(
  instanceId: string,
  moved: Session[],
  originalWorkspaceIds: Map<string, string | null>,
): Promise<boolean> {
  let failed = false
  for (const member of [...moved].reverse()) {
    await warpSession(instanceId, member.id, originalWorkspaceIds.get(member.id) ?? null).catch((rollbackError) => {
      failed = true
      log.error("Failed to roll back session worktree move", { instanceId, sessionId: member.id, rollbackError })
    })
  }
  return !failed
}

async function clearLegacyLocation(instanceId: string, rootId: string): Promise<void> {
  if (getCodeNomadSessionMetadata(instanceId, rootId).worktreeSlug) {
    await setSessionWorktreeSlug(instanceId, rootId, null)
  }
  await removeLegacyParentSessionMapping(instanceId, rootId)
}

async function moveSessionFamily(instanceId: string, sessionId: string, slug: string): Promise<boolean> {
  const root = getSessionRoot(instanceId, sessionId)
  if (!root) throw new Error(tGlobal("instanceShell.worktree.sessionNotFound"))
  const target = await targetLocation(instanceId, slug)
  const members = await requireCompleteFamily(instanceId, root)
  if (members.every((member) => (
    member.workspaceId === (target.workspaceId ?? undefined)
    && workspaceDirectoriesEqual(member.directory, target.worktree.directory)
  ))) {
    await clearLegacyLocation(instanceId, root.id)
    return false
  }
  if (members.some((session) => session.status === "working" || session.status === "compacting")) {
    throw new Error(tGlobal("instanceShell.worktree.moveBusy"))
  }

  const originalWorkspaceIds = new Map<string, string | null>()
  await Promise.all(members.map(async (member) => {
    originalWorkspaceIds.set(member.id, await originalWorkspaceId(instanceId, member))
  }))
  const moved: Session[] = []
  try {
    for (const member of members) {
      await warpSession(instanceId, member.id, target.workspaceId)
      moved.push(member)
    }
    await clearLegacyLocation(instanceId, root.id)
  } catch (error) {
    if (!await rollbackMovedMembers(instanceId, moved, originalWorkspaceIds)) {
      throw new Error(tGlobal("instanceShell.worktree.moveFailed"))
    }
    throw error
  }

  for (const member of members) {
    withSession(instanceId, member.id, (current) => {
      current.workspaceId = target.workspaceId ?? undefined
      current.directory = target.worktree.directory
    })
    forgetOpenCodeWorkspaceIdForSession(instanceId, member.id)
    if (target.workspaceId) rememberOpenCodeWorkspaceIdForSession(instanceId, member.id, target.workspaceId)
  }
  return true
}

async function moveSessionToWorktree(instanceId: string, sessionId: string, slug: string): Promise<boolean> {
  const root = getSessionRoot(instanceId, sessionId)
  if (!root) throw new Error(tGlobal("instanceShell.worktree.sessionNotFound"))
  const key = `${instanceId}:${root.id}`
  const task = (familyMoves.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => moveSessionFamily(instanceId, root.id, slug))
    .finally(() => {
      if (familyMoves.get(key) === task) familyMoves.delete(key)
    })
  familyMoves.set(key, task)
  return task
}

async function requireSessionWorkspacePayload(instanceId: string, sessionId: string): Promise<{ workspace?: string }> {
  let root = getSessionRoot(instanceId, sessionId)
  if (!root) throw new Error(tGlobal("instanceShell.worktree.sessionNotFound"))
  const pendingMove = familyMoves.get(`${instanceId}:${root.id}`)
  if (pendingMove) {
    await pendingMove
    root = getSessionRoot(instanceId, sessionId)
    if (!root) throw new Error(tGlobal("instanceShell.worktree.sessionNotFound"))
  }
  const slug = getWorktreeSlugForSession(instanceId, root.id)
  if (isWorktreeDeletionInProgress(instanceId, slug)) {
    throw new Error(tGlobal("instanceShell.worktree.moveFailed"))
  }
  const target = getWorktrees(instanceId).find((worktree) => worktree.slug === slug)
  const members = [root, ...getDescendantSessions(instanceId, root.id)]
  const familyLocationMatches = members.every((member) => (
    workspaceDirectoriesEqual(member.directory, root.directory) && member.workspaceId === root.workspaceId
  ))
  const nativeLocationMatches = familyLocationMatches && (
    (slug === "root" && !root.workspaceId && (!target || !root.directory || workspaceDirectoriesEqual(root.directory, target.directory)))
    || Boolean(target && root.workspaceId && workspaceDirectoriesEqual(root.directory, target.directory))
  )
  if (nativeLocationMatches) return root.workspaceId ? { workspace: root.workspaceId } : {}

  await moveSessionToWorktree(instanceId, root.id, slug)
  if (slug === "root") return {}
  const workspace = sessions().get(instanceId)?.get(root.id)?.workspaceId
  if (!workspace) throw locationError(slug)
  return { workspace }
}

async function requireWorktreeWorkspacePayload(instanceId: string, slug: string): Promise<{ workspace?: string }> {
  const target = await targetLocation(instanceId, slug)
  return target.workspaceId ? { workspace: target.workspaceId } : {}
}

export {
  moveSessionToWorktree,
  requireCompleteProjectSessionState,
  requireSessionWorkspacePayload,
  requireWorktreeWorkspacePayload,
}
