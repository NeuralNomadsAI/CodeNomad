import type { FastifyInstance } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { locationRequestOptions } from "../../opencode/compatibility/location"
import { deferPendingDiscovery } from "../../workspaces/pending-discovery"
import { assertOrdinaryMissionScheduleBody, assertOrdinaryMissionScheduleSession } from "../mission-schedule-input-guard"
import { requestAdmission } from "../request-admission"
import type { SessionCleanupFence } from "../session-cleanup-fence"
import { favoriteSessionId, sessionTargetCurrent } from "./session-favorites"

interface Deps {
  workspaceManager: Pick<WorkspaceManager, "get" | "getExistingSharedServiceConnection" | "ownsLocation" | "getWorktreeIdentityForPath">
  worktreeDeletionFence: WorktreeDeletionFence
  cleanup: SessionCleanupFence
  isProtected: (id: string) => boolean
}

export function registerSessionCleanupRoute(app: FastifyInstance, deps: Deps) {
  app.post<{ Params: { id: string; sessionId: string } }>("/api/workspaces/:id/session-cleanup/:sessionId", async (request, reply) => {
    const { id, sessionId } = request.params
    if (!favoriteSessionId.safeParse(sessionId).success) return reply.code(400).send()
    const manager = deps.workspaceManager
    const workspace = manager.get(id)
    if (!workspace) return reply.code(404).send()
    const connection = manager.getExistingSharedServiceConnection(id)
    if (!connection) return reply.code(503).send()
    const skipped = { deleted: false }
    const admission = requestAdmission(request, reply)
    const signal = AbortSignal.any([admission.signal, AbortSignal.timeout(10_000)])
    const current = sessionTargetCurrent(manager, id, workspace, connection, signal)
    const options = { signal }
    const client = connection.client
    let release: (() => void) | undefined
    let releaseWorktree: (() => void) | undefined
    let dispatched = false
    try {
      current()
      const initial = await client.session.get({ sessionID: sessionId }, options)
      if (initial.id !== sessionId || !initial.projectID || !await manager.ownsLocation(id, initial.location, client, { signal, strict: true })) return skipped
      current()
      release = deps.cleanup.enterCleanup(sessionId)
      if (!release || deps.isProtected(sessionId)) return skipped
      const session = await client.session.get({ sessionID: sessionId }, options)
      if (session.id !== sessionId || session.projectID !== initial.projectID || session.location.directory !== initial.location.directory
        || !await manager.ownsLocation(id, session.location, client, { signal, strict: true })) return skipped
      const identity = await manager.getWorktreeIdentityForPath(id, session.location.directory)
      if (!identity || !(releaseWorktree = deps.worktreeDeletionFence.enter([identity]))) return skipped
      assertOrdinaryMissionScheduleSession(session)
      const children = await client.session.list({ parentID: sessionId, project: session.projectID, limit: 1 }, options)
      if (!isEmptyPage(children)) return skipped
      const latest = await client.session.get({ sessionID: sessionId }, options)
      assertOrdinaryMissionScheduleBody({ metadata: latest.metadata })
      if (latest.id !== sessionId || latest.projectID !== session.projectID || latest.parentID !== session.parentID
        || latest.location.directory !== session.location.directory
        || !Number.isFinite(latest.time?.updated) || latest.time.updated !== session.time?.updated
        || latest.time.archived !== undefined || latest.revert || latest.fork
        || !await manager.ownsLocation(id, latest.location, client, { signal, strict: true })) return skipped
      const location = { directory: latest.location.directory }
      const permissionOptions = { ...locationRequestOptions(location), signal }
      if (deferPendingDiscovery(connection)) return skipped
      const forms = await client.session.form.list({ sessionID: sessionId }, options)
      if (!Array.isArray(forms) || forms.length || deferPendingDiscovery(connection)) return skipped
      const requests = await client.permission.request.list({ location }, permissionOptions)
      if (requests.location?.directory !== location.directory || !Array.isArray(requests.data)
        || requests.data.some(request => typeof request.sessionID !== "string" || request.sessionID === sessionId)) return skipped
      const inbox = await client.session.inbox.list({ sessionID: sessionId }, options)
      if (!Array.isArray(inbox) || inbox.length) return skipped
      const active = await client.session.active(options)
      if (!active || typeof active !== "object" || Array.isArray(active) || Object.hasOwn(active, sessionId)) return skipped
      const messages = await client.message.list({ sessionID: sessionId, limit: 1 }, options)
      if (!isEmptyPage(messages) || deps.isProtected(sessionId)) return skipped
      current()
      // The public native remove accepts only an ID. Keep the backend reservation
      // through settlement; clients bypassing this backend remain outside it.
      dispatched = true
      await client.session.remove({ sessionID: sessionId }, { signal: AbortSignal.timeout(60_000) })
      if (!admission.signal.aborted) return { deleted: true }
    } catch (error) {
      if (dispatched) deps.cleanup.markUncertain(sessionId)
      else if (isSessionNotFoundError(error) && error.sessionID === sessionId && deps.cleanup.hasUncertain(sessionId)) {
        try { current(); deps.cleanup.observeAbsent(sessionId) } catch { /* Retain the hold. */ }
      }
      if (!admission.signal.aborted) return dispatched ? reply.code(503).send() : skipped
    } finally {
      releaseWorktree?.()
      admission.dispose()
      release?.()
    }
  })
}

function isEmptyPage(value: { data: unknown; cursor?: { next?: unknown; previous?: unknown } } | null | undefined) {
  return Boolean(value && Array.isArray(value.data) && !value.data.length && value.cursor
    && typeof value.cursor === "object" && !Array.isArray(value.cursor)
    && value.cursor.next == null && value.cursor.previous == null)
}
import { isSessionNotFoundError } from "@opencode/client"
