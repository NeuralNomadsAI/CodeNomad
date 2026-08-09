import { tGlobal } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { requestData } from "../lib/opencode-api"
import { getRootClient } from "./opencode-client"
import {
  forgetOpenCodeWorkspaceIdForSession,
  getOpenCodeWorkspaceIdForWorktree,
  rememberOpenCodeWorkspaceIdForSession,
} from "./opencode-workspaces"
import { getDescendantSessions, getSessionRoot, sessions, withSession } from "./session-state"
import { setSessionWorktreeSlug } from "./session-metadata"
import {
  getWorktreeSlugForSession,
  getWorktrees,
  removeLegacyParentSessionMapping,
} from "./worktrees"

const log = getLogger("session")

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

async function moveSessionToWorktree(instanceId: string, sessionId: string, slug: string): Promise<void> {
  const root = getSessionRoot(instanceId, sessionId)
  if (!root) throw new Error(tGlobal("instanceShell.worktree.sessionNotFound"))
  const target = await targetLocation(instanceId, slug)
  if (root.workspaceId === (target.workspaceId ?? undefined) && root.directory === target.worktree.directory) return

  const members = [root, ...getDescendantSessions(instanceId, root.id)]
  if (members.some((session) => session.status === "working" || session.status === "compacting")) {
    throw new Error(tGlobal("instanceShell.worktree.moveBusy"))
  }

  const moved: typeof members = []
  try {
    for (const member of members) {
      await warpSession(instanceId, member.id, target.workspaceId)
      moved.push(member)
    }
  } catch (error) {
    for (const member of moved.reverse()) {
      await warpSession(instanceId, member.id, member.workspaceId ?? null).catch((rollbackError) => {
        log.error("Failed to roll back session worktree move", { instanceId, sessionId: member.id, rollbackError })
      })
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

  await setSessionWorktreeSlug(instanceId, root.id, null).catch((error) => {
    log.warn("Failed to clear migrated worktree metadata", { instanceId, sessionId: root.id, error })
  })
  await removeLegacyParentSessionMapping(instanceId, root.id)
}

async function requireSessionWorkspacePayload(instanceId: string, sessionId: string): Promise<{ workspace?: string }> {
  const root = getSessionRoot(instanceId, sessionId)
  if (!root) throw new Error(tGlobal("instanceShell.worktree.sessionNotFound"))
  if (root.workspaceId) return { workspace: root.workspaceId }

  const slug = getWorktreeSlugForSession(instanceId, root.id)
  if (slug === "root") return {}
  await moveSessionToWorktree(instanceId, root.id, slug)
  const workspace = sessions().get(instanceId)?.get(root.id)?.workspaceId
  if (!workspace) throw locationError(slug)
  return { workspace }
}

async function requireWorktreeWorkspacePayload(instanceId: string, slug: string): Promise<{ workspace?: string }> {
  const target = await targetLocation(instanceId, slug)
  return target.workspaceId ? { workspace: target.workspaceId } : {}
}

export { moveSessionToWorktree, requireSessionWorkspacePayload, requireWorktreeWorkspacePayload }
