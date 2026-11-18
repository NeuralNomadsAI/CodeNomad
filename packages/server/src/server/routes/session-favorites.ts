import { createHash } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { SESSION_FAVORITES_OWNER, type SettingsService } from "../../settings/service"
import { canonicalWorktreeIdentity, type WorkspaceManager } from "../../workspaces/manager"
import type { EventBus } from "../../events/bus"
import type { SessionFavorites } from "../../api-types"
import { isReservedMissionScheduleSessionID } from "../../missions/mission-schedule-carrier-identity"

const input = z.object({ favorite: z.boolean() }).strict()
const sessionId = z.string().regex(/^ses[A-Za-z0-9_-]{1,511}$/)
const favoriteRecords = z.record(sessionId, z.array(sessionId).max(64))
interface Deps {
  settings: Pick<SettingsService, "getSessionFavoritesState" | "mergePatchOwner">
  workspaceManager: Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "ownsLocation">
  eventBus: EventBus
}

export function registerSessionFavoritesRoutes(app: FastifyInstance, { settings, workspaceManager, eventBus }: Deps) {
  const scope = (workspace: NonNullable<ReturnType<WorkspaceManager["get"]>>) =>
    createHash("sha256").update(canonicalWorktreeIdentity(workspace.path)).digest("hex")
  const records = (key: string): SessionFavorites => {
    const state = settings.getSessionFavoritesState()
    return Object.hasOwn(state, key) ? favoriteRecords.parse(state[key]) : {}
  }
  const publish = (key: string, id: string, ancestors: string[] | null) =>
    settings.mergePatchOwner("state", SESSION_FAVORITES_OWNER, { [key]: { [id]: ancestors } })[key] as SessionFavorites
  const url = "/api/workspaces/:id/session-favorites"
  app.get<{ Params: { id: string } }>(url, async (request, reply) => {
    reply.header("cache-control", "no-store")
    const workspace = workspaceManager.get(request.params.id)
    if (!workspace) return reply.code(404).send()
    try {
      return records(scope(workspace))
    } catch (error) {
      request.log.warn({ err: error }, "Could not read session favorites")
      return reply.code(503).send()
    }
  })
  app.put<{ Params: { id: string; sessionId: string } }>(`${url}/:sessionId`, async (request, reply) => {
    const parsed = input.safeParse(request.body)
    const { id, sessionId: target } = request.params
    if (!parsed.success || !sessionId.safeParse(target).success || isReservedMissionScheduleSessionID(target)) return reply.code(400).send()
    const workspace = workspaceManager.get(id)
    if (!workspace) return reply.code(404).send()
    const key = scope(workspace)
    const signal = AbortSignal.timeout(8_000)
    try {
      const connection = await workspaceManager.getSharedServiceConnection(id)
      if (!connection) return reply.code(503).send()
      const current = () => {
        signal.throwIfAborted()
        connection.assertCurrent()
        if (workspaceManager.get(id) !== workspace) throw new Error("Workspace changed")
      }
      current()
      const session = await connection.client.session.get({ sessionID: target }, { signal })
      if (session.id !== target || !await workspaceManager.ownsLocation(id, session.location, connection.client, { signal, strict: true })) {
        return reply.code(403).send()
      }
      const ancestors: string[] = []
      for (let parent = parsed.data.favorite ? session.parentID : undefined; parent;) {
        if (parent === target || ancestors.includes(parent) || ancestors.length >= 64) return reply.code(409).send()
        if (!sessionId.safeParse(parent).success || isReservedMissionScheduleSessionID(parent)) return reply.code(409).send()
        const info = await connection.client.session.get({ sessionID: parent }, { signal })
        if (info.id !== parent || !await workspaceManager.ownsLocation(id, info.location, connection.client, { signal, strict: true })) {
          return reply.code(403).send()
        }
        ancestors.push(parent)
        parent = info.parentID
      }
      const latest = await connection.client.session.get({ sessionID: target }, { signal })
      current()
      if (latest.id !== target || latest.location.directory !== session.location.directory || latest.parentID !== session.parentID) return reply.code(409).send()
      const previous = records(key)
      if (parsed.data.favorite && !Object.hasOwn(previous, target) && Object.keys(previous).length >= 512) {
        return reply.code(409).send()
      }
      return publish(key, target, parsed.data.favorite ? ancestors : null)
    } catch (error) {
      request.log.warn({ err: error }, "Could not save session favorite")
      return reply.code(503).send()
    }
  })
  // The relay has already attributed the deletion to this owned workspace.
  const stop = eventBus.onEvent(event => {
    if (event.type !== "instance.event" || event.event.type !== "session.deleted") return
    const workspace = workspaceManager.get(event.instanceId)
    const target = (event.event.data as { sessionID?: string }).sessionID
    if (!workspace || !target || !sessionId.safeParse(target).success) return
    const key = scope(workspace)
    try {
      const current = records(key)
      const removed = Object.entries(current).filter(([id, parents]) =>
        id === target || (Array.isArray(parents) && parents.includes(target)))
      if (removed.length) settings.mergePatchOwner("state", SESSION_FAVORITES_OWNER,
        { [key]: Object.fromEntries(removed.map(([id]) => [id, null])) })
    } catch (error) {
      app.log.warn({ err: error }, "Could not remove deleted favorites")
    }
  })
  app.addHook("onClose", async () => stop())
}
