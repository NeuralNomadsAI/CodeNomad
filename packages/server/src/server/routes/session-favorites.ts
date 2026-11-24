import { createHash, randomUUID } from "node:crypto"
import { isSessionNotFoundError } from "@opencode/client"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { SessionFavoritesSnapshot } from "../../api-types"
import type { EventBus } from "../../events/bus"
import { isReservedMissionScheduleSessionID } from "../../missions/mission-schedule-carrier-identity"
import { SESSION_FAVORITES_OWNER, type SettingsService } from "../../settings/service"
import { canonicalWorktreeIdentity, type WorkspaceManager } from "../../workspaces/manager"
import { nativeEventConnections, type ServiceConnection } from "../../workspaces/opencode-service"
import type { SessionCleanupFence } from "../session-cleanup-fence"

export const favoriteSessionId = z.string().regex(/^ses[A-Za-z0-9_-]{1,511}$/)
const favoriteState = z.record(z.string().regex(/^[a-f0-9]{64}$/), z.record(favoriteSessionId, z.array(favoriteSessionId).max(64)))
const input = z.object({ favorite: z.boolean() }).strict()
const limit = 512
type FavoriteState = z.infer<typeof favoriteState>
type Manager = Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "getExistingSharedServiceConnection" | "ownsLocation">
interface Deps {
  settings: Pick<SettingsService, "getSessionFavoritesState" | "mergePatchOwner">
  workspaceManager: Manager
  eventBus: EventBus
  cleanup: SessionCleanupFence
  reconciliationDeadline?: () => AbortSignal
}

export function sessionTargetCurrent(manager: Pick<Manager, "get">, id: string,
  workspace: ReturnType<Manager["get"]>, connection: ServiceConnection, signal: AbortSignal) {
  return () => {
    signal.throwIfAborted()
    connection.assertCurrent()
    if (!workspace || manager.get(id) !== workspace) throw new Error("Workspace changed")
  }
}

export function registerSessionFavoritesRoutes(app: FastifyInstance, {
  settings, workspaceManager, eventBus, cleanup, reconciliationDeadline = () => AbortSignal.timeout(6_000),
}: Deps) {
  let snapshot: { raw: object; state: FavoriteState; protectedIds: Set<string>; revision: number } | undefined
  const source = randomUUID()
  let revision = 0
  const read = () => {
    const raw = settings.getSessionFavoritesState()
    if (snapshot?.raw === raw) return snapshot
    const state = favoriteState.parse(raw)
    const protectedIds = new Set<string>()
    for (const records of Object.values(state)) for (const [id, parents] of Object.entries(records)) {
      protectedIds.add(id)
      for (const parent of parents) protectedIds.add(parent)
    }
    return snapshot = { raw, state, protectedIds, revision: ++revision }
  }
  const scope = (workspace: NonNullable<ReturnType<Manager["get"]>>) =>
    createHash("sha256").update(canonicalWorktreeIdentity(workspace.path)).digest("hex")
  const reconciling = new Map<string, { task: Promise<void>; changed: Set<string> }>()
  const publish = (patch: Record<string, Record<string, string[] | null>>) => {
    settings.mergePatchOwner("state", SESSION_FAVORITES_OWNER, patch)
    for (const [key, entries] of Object.entries(patch)) {
      const scan = reconciling.get(key)
      if (scan) for (const id of Object.keys(entries)) scan.changed.add(id)
    }
  }
  // All ancestry is private protection data, including ancestors outside the workspace.
  const display = (key: string, state = read()): SessionFavoritesSnapshot => ({
    source, revision: state.revision, records: Object.fromEntries(Object.keys(state.state[key] ?? {}).map(id => [id, []])),
  })
  const absent = (error: unknown, id: string) => isSessionNotFoundError(error) && error.sessionID === id
  const lifetime = new AbortController()
  function reconcile(id: string, key: string, connection: ServiceConnection, observed: ReturnType<typeof read>): Promise<void> {
    const pending = reconciling.get(key)
    if (pending) return pending.task
    if (reconciling.size >= 4) return Promise.resolve()
    const workspace = workspaceManager.get(id)
    const ids = Object.keys(observed.state[key] ?? {})
    if (!ids.length) return Promise.resolve()
    const signal = AbortSignal.any([lifetime.signal, reconciliationDeadline()])
    const current = sessionTargetCurrent(workspaceManager, id, workspace, connection, lifetime.signal)
    const missing: Record<string, null> = {}
    const changed = new Set<string>()
    let offset = 0
    const scan = async () => {
      while (offset < ids.length && !signal.aborted) {
        const target = ids[offset++]
        try {
          current()
          await connection.client.session.get({ sessionID: target }, { signal })
        } catch (error) {
          if (!signal.aborted && absent(error, target)) {
            current()
            missing[target] = null
          }
        }
      }
    }
    const task = Promise.allSettled(Array.from({ length: Math.min(4, ids.length) }, scan)).then(() => {
      current()
      const entries = read().state[key] ?? {}
      const confirmed = Object.fromEntries(Object.keys(missing).filter(target =>
        !changed.has(target) && Object.hasOwn(entries, target)
        && JSON.stringify(entries[target]) === JSON.stringify(observed.state[key]?.[target]))
        .map(target => [target, null]))
      if (Object.keys(confirmed).length) publish({ [key]: confirmed })
    }).catch(() => { /* Uncertain or superseded discovery retains the entries. */ })
      .finally(() => reconciling.delete(key))
    reconciling.set(key, { task, changed })
    return task
  }

  const url = "/api/workspaces/:id/session-favorites"
  app.get<{ Params: { id: string }; Querystring: { reconcile?: string } }>(url, async (request, reply) => {
    reply.header("cache-control", "no-store")
    const { id } = request.params
    const workspace = workspaceManager.get(id)
    if (!workspace) return reply.code(404).send()
    try {
      const key = scope(workspace), state = read()
      const connection = request.query.reconcile === "1" && workspaceManager.getExistingSharedServiceConnection(id)
      if (connection) void reconcile(id, key, connection, state)
      return display(key, state)
    } catch {
      return reply.code(503).send()
    }
  })
  app.put<{ Params: { id: string; sessionId: string } }>(`${url}/:sessionId`, async (request, reply) => {
    const parsed = input.safeParse(request.body)
    const { id, sessionId: target } = request.params
    if (!parsed.success || !favoriteSessionId.safeParse(target).success || isReservedMissionScheduleSessionID(target)) return reply.code(400).send()
    const workspace = workspaceManager.get(id)
    if (!workspace) return reply.code(404).send()
    const key = scope(workspace)
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(8_000)])
    const releases: (() => void)[] = []
    try {
      const state = read(), entries = state.state[key] ?? {}
      if (!parsed.data.favorite) {
        // Withdrawal names an entry of this workspace, not a native operation.
        if (Object.hasOwn(entries, target)) publish({ [key]: { [target]: null } })
        return display(key)
      }
      const connection = await workspaceManager.getSharedServiceConnection(id)
      if (!connection) return reply.code(503).send()
      const current = sessionTargetCurrent(workspaceManager, id, workspace, connection, signal)
      if (!Object.hasOwn(entries, target) && Object.keys(entries).length >= limit) await reconcile(id, key, connection, state)
      current()
      const session = await connection.client.session.get({ sessionID: target }, { signal })
      if (session.id !== target || !await workspaceManager.ownsLocation(id, session.location, connection.client, { signal })) {
        return reply.code(403).send()
      }
      const ancestors: string[] = []
      for (let parent = session.parentID; parent;) {
        current()
        if (parent === target || ancestors.includes(parent) || ancestors.length >= 64
          || !favoriteSessionId.safeParse(parent).success || isReservedMissionScheduleSessionID(parent)) return reply.code(409).send()
        ancestors.push(parent)
        const info = await connection.client.session.get({ sessionID: parent }, { signal })
        if (info.id !== parent) return reply.code(409).send()
        parent = info.parentID
      }
      for (const member of [target, ...ancestors]) {
        const release = cleanup.enterMutation(member)
        if (!release) return reply.code(409).send()
        releases.push(release)
      }
      const latest = await connection.client.session.get({ sessionID: target }, { signal })
      current()
      if (latest.id !== target || latest.location.directory !== session.location.directory || latest.parentID !== session.parentID) return reply.code(409).send()
      const previous = read().state[key] ?? {}
      if (!Object.hasOwn(previous, target) && Object.keys(previous).length >= limit) return reply.code(409).send()
      publish({ [key]: { [target]: ancestors } })
      return display(key)
    } catch (error) {
      if (absent(error, target)) return reply.code(404).send()
      request.log.warn("Could not save session favorite")
      return reply.code(503).send()
    } finally {
      for (const release of releases) release()
    }
  })
  const stop = eventBus.onEvent(event => {
    if (event.type !== "instance.event" || event.event.type !== "session.deleted") return
    const target = (event.event.data as { sessionID?: string }).sessionID
    if (!target || !favoriteSessionId.safeParse(target).success) return
    const provenance = nativeEventConnections.get(event.event)
    if (provenance && provenance === workspaceManager.getExistingSharedServiceConnection(event.instanceId)) {
      try { provenance.assertCurrent(); cleanup.observeAbsent(target) } catch { /* An old stream cannot release a hold. */ }
    }
    try {
      const state = read()
      if (!state.protectedIds.has(target)) return
      const patch = Object.fromEntries(Object.entries(state.state).flatMap(([key, entries]) => {
        const removed = Object.entries(entries).filter(([id, parents]) => id === target || parents.includes(target))
        return removed.length ? [[key, Object.fromEntries(removed.map(([id]) => [id, null]))]] : []
      }))
      if (Object.keys(patch).length) publish(patch)
    } catch { app.log.warn("Could not remove deleted favorites") }
  })
  app.addHook("onClose", async () => { stop(); lifetime.abort(); await Promise.all([...reconciling.values()].map(scan => scan.task)) })
  return (id: string) => read().protectedIds.has(id)
}
