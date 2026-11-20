import { isSessionNotFoundError, type SessionInfo } from "@opencode/client"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { isReservedMissionScheduleSessionID } from "../../missions/mission-schedule-carrier-identity"
import { sameLocation } from "../../opencode/compatibility/location"
import { SessionModeConflict, type NativeTarget, type SessionPermissionModes } from "../../permissions/session-mode"
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

export function sessionPermissionTarget(initial: SessionInfo, target: Omit<NativeTarget, "sessionID" | "read" | "readAncestor">,
  owns: (location: SessionInfo["location"]) => Promise<boolean>): NativeTarget {
  const { client, current, signal } = target
  return {
    ...target,
    sessionID: initial.id,
    read: async () => {
      current()
      const latest = await client.session.get({ sessionID: initial.id }, { signal })
      current()
      if (latest.id !== initial.id || !sameLocation(latest.location, initial.location)
        || latest.projectID !== initial.projectID || latest.time.created !== initial.time.created) {
        throw new SessionModeConflict("Conversation changed")
      }
      return latest
    },
    readAncestor: async ancestorID => {
      if (!ordinaryPermissionSession(ancestorID)) return
      current()
      try {
        const ancestor = await client.session.get({ sessionID: ancestorID }, { signal })
        const owned = ancestor.id === ancestorID && ancestor.projectID === initial.projectID && await owns(ancestor.location)
        current()
        return owned ? ancestor : undefined
      } catch (error) {
        current()
        if (isSessionNotFoundError(error) && error.sessionID === ancestorID) return
        throw error
      }
    },
  }
}

export async function recordPermissionFork(response: Response, modes: SessionPermissionModes, source: SessionInfo,
  scope: Omit<NativeTarget, "sessionID" | "read" | "readAncestor">, owns: (location: SessionInfo["location"]) => Promise<boolean>) {
  const { data: session } = await response.clone().json() as { data: SessionInfo }
  scope.current()
  if (!session || !ordinaryPermissionSession(session.id) || session.fork?.sessionID !== source.id
    || session.projectID !== source.projectID || !sameLocation(session.location, source.location)) return
  await modes.observeCopy(scope.distro, session.id, source.id, async () => {
    const target = sessionPermissionTarget(session, scope, owns)
    const fresh = await target.read()
    if (fresh.fork?.sessionID !== source.id || !await owns(fresh.location)) return
    return { session, target, rules: sessionPermissionRules.parse(session.permissions ?? []), exactNativeCopy: true }
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
      let releaseSession: (() => void) | undefined
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
        const initial = await client.session.get({ sessionID }, { signal })
        if (initial.id !== sessionID || !await manager.ownsLocation(id, initial.location, client, { signal })) return reply.code(403).send()
        current()
        if (parsed?.success) {
          const identity = await manager.getWorktreeIdentityForPath(id, initial.location.directory)
          current()
          if (!identity) return reply.code(403).send()
          releaseWorktree = deps.worktreeDeletionFence.enter([identity])
          releaseSession = deps.cleanup.enterMutation(sessionID)
          if (!releaseWorktree || !releaseSession) return reply.code(409).send()
        }
        const target = sessionPermissionTarget(initial, { client, current, signal, distro: manager.getServiceWslDistro(id) },
          location => manager.ownsLocation(id, location, client, { signal }))
        return parsed?.success ? await deps.modes.write(target, parsed.data.mode) : await deps.modes.read(target)
      } catch (error) {
        if (isSessionNotFoundError(error) && error.sessionID === sessionID) return reply.code(404).send()
        if (error instanceof SessionModeConflict) return reply.code(409).send({ error: error.message })
        return reply.code(503).send({ error: "Conversation permissions unavailable" })
      } finally {
        releaseSession?.()
        releaseWorktree?.()
        lifetime.dispose()
      }
    },
  })
}
