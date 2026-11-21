import { isSessionNotFoundError, type SessionInfo } from "@opencode/client"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { isReservedMissionScheduleSessionID } from "../../missions/mission-schedule-carrier-identity"
import { sameLocation } from "../../opencode/compatibility/location"
import { isPermissionRoot, SessionModeConflict, UnverifiedPermissionBlock, type NativeTarget, type SessionPermissionModes } from "../../permissions/session-mode"
import { sessionPermissionRules } from "../../permissions/session-mode-rules"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { requestAdmission } from "../request-admission"
import type { SessionCleanupFence } from "../session-cleanup-fence"

interface Deps {
  workspaceManager: Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "getServiceWslDistro" | "ownsLocation" | "getWorktreeIdentityForPath">
  modes: SessionPermissionModes
  worktreeDeletionFence: WorktreeDeletionFence
  cleanup: SessionCleanupFence
}
const input = z.object({ mode: z.enum(["autonomous", "supervised"]) }).strict()
const sessionIDPattern = /^ses[A-Za-z0-9_-]{1,511}$/
export const ordinaryPermissionSession = (id: string) => sessionIDPattern.test(id) && !isReservedMissionScheduleSessionID(id)

type NativeScope = Omit<NativeTarget, "sessionID" | "read">

export function sessionPermissionTarget(initial: SessionInfo, target: NativeScope): NativeTarget {
  const { client, current, signal } = target
  return {
    ...target,
    sessionID: initial.id,
    read: async () => {
      current()
      const latest = await client.session.get({ sessionID: initial.id }, { signal })
      current()
      if (latest.id !== initial.id || !sameLocation(latest.location, initial.location)
        || latest.projectID !== initial.projectID || latest.time.created !== initial.time.created
        || latest.parentID !== initial.parentID || latest.fork?.sessionID !== initial.fork?.sessionID) {
        throw new SessionModeConflict("Conversation changed")
      }
      return latest
    },
  }
}

async function permissionRoot(initial: SessionInfo, { client, current, signal }: NativeScope,
  owns: (location: SessionInfo["location"]) => Promise<boolean>) {
  let session = initial
  const visited = new Set([session.id])
  while (!isPermissionRoot(session)) {
    const id = session.parentID!
    if (!ordinaryPermissionSession(id) || visited.has(id) || visited.size >= 64) return
    visited.add(id)
    try {
      session = await client.session.get({ sessionID: id }, { signal })
    } catch (error) {
      if (isSessionNotFoundError(error) && error.sessionID === id) return
      throw error
    }
    if (session.id !== id || session.projectID !== initial.projectID || !await owns(session.location)) return
    current()
  }
  return session
}

export async function recordPermissionFork(response: Response, modes: SessionPermissionModes, source: SessionInfo,
  scope: NativeScope, owns: (location: SessionInfo["location"]) => Promise<boolean>) {
  const { data: session } = await response.clone().json() as { data: SessionInfo }
  scope.current()
  if (!session || !ordinaryPermissionSession(session.id) || session.fork?.sessionID !== source.id
    || session.projectID !== source.projectID || !sameLocation(session.location, source.location)) return
  await modes.observeCopy(scope.distro, session.id, source.id, async () => {
    const currentSource = await sessionPermissionTarget(source, scope).read()
    const fresh = await sessionPermissionTarget(session, scope).read()
    if (fresh.fork?.sessionID !== source.id || !await owns(fresh.location)) return
    return { session: fresh, source: currentSource, current: scope.current, rules: sessionPermissionRules.parse(session.permissions ?? []) }
  })
}

export function registerSessionPermissionModeRoutes(app: FastifyInstance, deps: Deps) {
  const manager = deps.workspaceManager
  app.route<{ Params: { id: string; sessionId: string } }>({
    method: ["GET", "PUT"], url: "/api/workspaces/:id/sessions/:sessionId/permission-mode",
    bodyLimit: 1024,
    handler: async (request, reply) => {
      reply.header("cache-control", "no-store")
      const { id, sessionId: sessionID } = request.params
      const parsed = request.method === "PUT" ? input.safeParse(request.body) : undefined
      if (!ordinaryPermissionSession(sessionID) || parsed?.success === false) return reply.code(400).send()
      const workspace = manager.get(id)
      if (!workspace) return reply.code(404).send()
      const lifetime = requestAdmission(request, reply)
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)])
      let releaseWorktree: (() => void) | undefined
      const releaseSessions: Array<() => void> = []
      try {
        const connection = await manager.getSharedServiceConnection(id)
        if (!connection) return reply.code(503).send()
        const { client } = connection
        const current = () => {
          signal.throwIfAborted()
          connection.assertCurrent()
          if (manager.get(id) !== workspace) throw new SessionModeConflict("Workspace changed")
        }
        current()
        const scope = { client, current, signal, distro: manager.getServiceWslDistro(id) }
        const owns = (location: SessionInfo["location"]) => manager.ownsLocation(id, location, client, { signal })
        const selected = await client.session.get({ sessionID }, { signal })
        if (selected.id !== sessionID || !await owns(selected.location)) return reply.code(403).send()
        current()
        const root = await permissionRoot(selected, scope, owns)
        if (!root) return reply.code(409).send({ error: "Conversation family unavailable" })
        if (parsed?.success) {
          const ids = selected.id === root.id ? [root.id] : [selected.id, root.id]
          const directories = [...new Set([selected.location.directory, root.location.directory])]
          const identities = await Promise.all(directories.map(directory => manager.getWorktreeIdentityForPath(id, directory)))
          current()
          if (identities.some(identity => !identity)) return reply.code(403).send()
          releaseWorktree = deps.worktreeDeletionFence.enter(identities as string[])
          if (!releaseWorktree) return reply.code(409).send()
          for (const actor of ids) {
            const release = deps.cleanup.enterMutation(actor)
            if (!release) return reply.code(409).send()
            releaseSessions.push(release)
          }
        }
        const target = sessionPermissionTarget(root, scope)
        const result = parsed?.success ? await deps.modes.write(target, parsed.data.mode) : await deps.modes.read(target)
        return selected.id === root.id ? result : { ...result, rootSessionID: root.id }
      } catch (error) {
        if (isSessionNotFoundError(error) && error.sessionID === sessionID) return reply.code(404).send()
        if (error instanceof UnverifiedPermissionBlock) return reply.code(409).send({ error: error.message, code: "PERMISSION_BLOCK_UNVERIFIED" })
        if (error instanceof SessionModeConflict) return reply.code(409).send({ error: error.message })
        return reply.code(503).send({ error: "Conversation permissions unavailable" })
      } finally {
        for (const release of releaseSessions) release()
        releaseWorktree?.()
        lifetime.dispose()
      }
    },
  })
}
