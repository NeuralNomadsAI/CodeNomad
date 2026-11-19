import { isSessionNotFoundError } from "@opencode/client"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { isReservedMissionScheduleSessionID } from "../../missions/mission-schedule-carrier-identity"
import { SessionModeConflict, type SessionPermissionModes } from "../../permissions/session-mode"
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

export function registerSessionPermissionModeRoutes(app: FastifyInstance, deps: Deps) {
  const manager = deps.workspaceManager
  app.route<{ Params: { id: string; sessionId: string } }>({
    method: ["GET", "PUT"], url: "/api/workspaces/:id/sessions/:sessionId/permission-mode",
    bodyLimit: 1024,
    handler: async (request, reply) => {
      reply.header("cache-control", "no-store")
      const { id, sessionId: sessionID } = request.params
      const parsed = request.method === "PUT" ? input.safeParse(request.body) : undefined
      if (!sessionIDPattern.test(sessionID) || parsed?.success === false || isReservedMissionScheduleSessionID(sessionID)) return reply.code(400).send()
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
        const read = async () => {
          current()
          const latest = await client.session.get({ sessionID }, { signal })
          current()
          if (latest.id !== sessionID || latest.location.directory !== initial.location.directory
            || latest.projectID !== initial.projectID || latest.time.created !== initial.time.created) {
            throw new SessionModeConflict("Conversation changed")
          }
          return latest
        }
        const readAncestor = async (ancestorID: string) => {
          if (!sessionIDPattern.test(ancestorID) || isReservedMissionScheduleSessionID(ancestorID)) return
          current()
          try {
            const ancestor = await client.session.get({ sessionID: ancestorID }, { signal })
            const owned = ancestor.id === ancestorID && ancestor.projectID === initial.projectID
              && await manager.ownsLocation(id, ancestor.location, client, { signal })
            current()
            return owned ? ancestor : undefined
          } catch (error) {
            current()
            if (isSessionNotFoundError(error) && error.sessionID === ancestorID) return
            throw error
          }
        }
        const target = { client, current, signal, distro: manager.getServiceWslDistro(id), read, readAncestor }
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
