import { tGlobal } from "../lib/i18n"
import { serverApi } from "../lib/api-client"
import { findWorktreeSlugForDirectory, workspaceDirectoriesEqual } from "./opencode-workspace-matching"
import {
  forgetOpenCodeWorkspaceIdForSession,
  getOpenCodeWorkspaceIdForWorktree,
  rememberOpenCodeWorkspaceIdForSession,
} from "./opencode-workspaces"
import { getDescendantSessions, getSessionRoot, sessions, withSession } from "./session-state"
import { clearLocalSessionWorktreeSlug } from "./session-metadata"
import { setAuthoritativeSessionLocation } from "./session-location-authority"
import {
  getWorktreeSlugForSession,
  getWorktrees,
  isWorktreeDeletionInProgress,
  reloadWorktreeMap,
} from "./worktrees"

const familyMoves = new Map<string, Promise<boolean>>()

function locationError(slug: string): Error {
  return new Error(tGlobal("instanceShell.worktree.locationUnavailable", { slug }))
}

async function requireCompleteProjectSessionState(instanceId: string): Promise<void> {
  const { fetchSessions } = await import("./session-api")
  await fetchSessions(instanceId, { reset: false, strictStatus: true })
}

async function moveSessionFamily(instanceId: string, sessionId: string, slug: string): Promise<boolean> {
  const root = getSessionRoot(instanceId, sessionId)
  if (!root) throw new Error(tGlobal("instanceShell.worktree.sessionNotFound"))
  const before = new Map([root, ...getDescendantSessions(instanceId, root.id)].map((member) => [member.id, {
    directory: member.directory,
    workspaceId: member.workspaceId,
  }]))
  let moved
  try {
    moved = await serverApi.moveWorktreeSessionFamily(instanceId, root.id, { worktreeSlug: slug })
  } catch (error) {
    await requireCompleteProjectSessionState(instanceId).catch(() => undefined)
    throw error
  }
  if (moved.rootSessionId !== root.id || moved.worktreeSlug !== slug) {
    await requireCompleteProjectSessionState(instanceId)
    throw new Error(tGlobal("instanceShell.worktree.moveFailed"))
  }
  clearLocalSessionWorktreeSlug(instanceId, root.id)
  for (const location of moved.sessions) {
    setAuthoritativeSessionLocation(instanceId, location.sessionId, {
      workspaceId: location.workspaceId ?? undefined,
      directory: location.directory,
    }, before.get(location.sessionId), sessions().get(instanceId)?.get(location.sessionId)?.time.updated)
    withSession(instanceId, location.sessionId, (current) => {
      current.workspaceId = location.workspaceId ?? undefined
      current.directory = location.directory
    })
    forgetOpenCodeWorkspaceIdForSession(instanceId, location.sessionId)
    if (location.workspaceId) rememberOpenCodeWorkspaceIdForSession(instanceId, location.sessionId, location.workspaceId)
  }
  await reloadWorktreeMap(instanceId)
  return moved.sessions.some((location) => {
    const previous = before.get(location.sessionId)
    return !previous || previous.workspaceId !== (location.workspaceId ?? undefined)
      || !workspaceDirectoriesEqual(previous.directory, location.directory)
  })
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
    (slug === "root" && !root.workspaceId && (!target || !root.directory || workspaceDirectoriesEqual(root.directory, target.nativeDirectory ?? target.directory)))
    || Boolean(target && root.workspaceId && workspaceDirectoriesEqual(root.directory, target.nativeDirectory ?? target.directory))
  )
  if (nativeLocationMatches) return root.workspaceId ? { workspace: root.workspaceId } : {}

  await moveSessionToWorktree(instanceId, root.id, slug)
  if (slug === "root") return {}
  const workspace = sessions().get(instanceId)?.get(root.id)?.workspaceId
  if (!workspace) throw locationError(slug)
  return { workspace }
}

async function requireWorktreeWorkspacePayload(instanceId: string, slug: string): Promise<{ workspace?: string }> {
  if (slug === "root") return {}
  const workspace = await getOpenCodeWorkspaceIdForWorktree(instanceId, slug)
  if (!workspace) throw locationError(slug)
  return { workspace }
}

export {
  moveSessionToWorktree,
  requireCompleteProjectSessionState,
  requireSessionWorkspacePayload,
  requireWorktreeWorkspacePayload,
}
