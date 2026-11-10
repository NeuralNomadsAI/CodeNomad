import { createHash } from "node:crypto"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { locationRequestOptions, readLocationRef, sameLocation } from "../../opencode/compatibility/location"
import { captureDisplayIdentities } from "../../workspaces/worktree-display-identity"
import { PRUNING_RPC_ID } from "../../opencode/session-pruning/contract"
import { historyQuerySchema, historyNativeResultSchema, pruneBatchSchema, pruneBatchResultSchema } from "../../opencode/session-pruning/history-contract"
import { historyDirectories, ownedHistorySessions } from "./session-history-scope"
import { registerRankedHistoryRoute } from "./session-history-ranked"
import { assertOrdinaryMissionScheduleSession } from "../mission-schedule-input-guard"

export interface HistoryRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "get" | "getSharedServiceClient" | "getSharedServiceConnection" | "ownsLocation" | "getWorktreeIdentityForPath" | "getServiceLocation" | "getWorktrees" | "desktopPluginsReady">
  worktreeDeletionFence: WorktreeDeletionFence
}
const cursorSchema = z.object({ directory: z.string().max(4096), page: z.string().max(4096).optional(), binding: z.string().length(64) }).strict()

export function registerSessionHistoryRoutes(app: FastifyInstance, deps: HistoryRouteDeps) {
  registerRankedHistoryRoute(app, deps)
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/session-history/query", { bodyLimit: 16_384 }, async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid history query" })
    const input = parsed.data
    const manager = deps.workspaceManager
    const root = manager.getServiceLocation(request.params.id)
    if (!root) return reply.code(404).send({ error: "Workspace not found" })
    const workspace = manager.get(request.params.id)
    const fences = [deps.worktreeDeletionFence.captureDisplay([root.directory])]
    const deadlineAt = Date.now() + 15_000
    const abandoned = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) abandoned.abort() }
    reply.raw.once("close", abort)
    const signal = AbortSignal.any([abandoned.signal, AbortSignal.timeout(15_000)])
    try {
      const connection = await manager.getSharedServiceConnection(request.params.id)
      if (!connection || !workspace) throw new Error("Workspace unavailable")
      const client = connection.client
      const current = () => {
        signal.throwIfAborted(); connection.assertCurrent()
        if (manager.get(request.params.id) !== workspace || manager.getServiceLocation(request.params.id) !== root || fences.some(check => !check())) throw new Error("History placement changed")
      }
      current()
      const session = input.sessionID ? await client.session.get({ sessionID: input.sessionID }, { signal }) : undefined
      current()
      if (session && !await manager.ownsLocation(request.params.id, session.location, client, signal)) return reply.code(403).send({ error: "Session does not belong to workspace" })
      current()
    // Only native/validated local worktrees supply query locations. A cursor
    // selects from this freshly authorized inventory; it never grants authority.
      const directories = session ? [session.location.directory] : await historyDirectories(manager, request.params.id, root.directory)
      current()
      const binding = createHash("sha256").update(JSON.stringify([request.params.id, input.sessionID, input.query, input.includeTechnical, input.purpose, directories])).digest("hex")
      let cursor: z.infer<typeof cursorSchema> | undefined
      try {
        cursor = input.cursor ? cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString())) : undefined
        if (cursor && (cursor.binding !== binding || !directories.includes(cursor.directory))) throw new Error("Stale cursor")
      } catch { return reply.code(400).send({ error: "Invalid history cursor" }) }
      const index = cursor ? directories.indexOf(cursor.directory) : 0
      const directory = directories[index]
      if (!directory) return reply.code(404).send({ error: "History location not found" })
      current()
      if (!await manager.ownsLocation(request.params.id, { directory }, client, signal)) return reply.code(403).send({ error: "History location does not belong to workspace" })
      current()
      fences.push((await captureDisplayIdentities(deps.worktreeDeletionFence, manager, request.params.id, [directory]))!)
      current()
      const location = session ? readLocationRef(session.location) : directory === root.directory ? root
        : readLocationRef(await client.location.get({ location: { directory } }, { signal }))
      current()
      if (location.directory !== directory || !await manager.ownsLocation(request.params.id, location, client, signal)) {
        return reply.code(403).send({ error: "History location does not belong to workspace" })
      }
      current()
      const revalidate = async () => {
        current()
        if (input.sessionID) {
          const latest = await client.session.get({ sessionID: input.sessionID }, { signal })
          current()
          if (!sameLocation(location, readLocationRef(latest.location))) throw new Error("Session moved")
        }
        if (!await manager.ownsLocation(request.params.id, location, client, signal)) throw new Error("History ownership changed")
        current()
      }
      await manager.desktopPluginsReady({ connection, location: { directory }, signal, deadlineAt, assertCurrent: current })
      await revalidate()
      current()
      const result = await client.rpc.call({ rpcID: PRUNING_RPC_ID, method: "history",
        input: JSON.parse(JSON.stringify({ ...input, cursor: cursor?.page })), location: { directory } },
      { ...locationRequestOptions(location), signal })
      await revalidate()
      const output = historyNativeResultSchema.parse(result.output)
      if (output.status !== "page") return output
      // Validate every contributing directory against local Git ownership, not
      // just its lexical ancestor or native project ID. Never expose provenance
      // or counts/excerpts from an independent nested clone to the browser.
      // Ownership is location-scoped. Reuse it only within this request, never
      // across inventory changes or independent clones sharing a project ID.
      const owned = await ownedHistorySessions(manager, request.params.id, client, output.sessions, input.sessionID, current, signal)
      const ownedIDs = new Set(owned.map(candidate => candidate.sessionID))
      const next = output.cursor ? { directory, page: output.cursor, binding }
        : directories[index + 1] ? { directory: directories[index + 1], binding } : undefined
      current()
      return { status: "page", scanned: owned.reduce((n, owner) => n + owner.scanned, 0),
        tools: owned.reduce((n, owner) => n + owner.tools, 0), reasoning: owned.reduce((n, owner) => n + owner.reasoning, 0),
        skipped: owned.reduce((n, owner) => n + owner.skipped, 0),
        hits: output.hits.filter(hit => ownedIDs.has(hit.sessionID)),
        candidates: input.sessionID && ownedIDs.has(input.sessionID) ? output.candidates : [],
        cursor: next ? Buffer.from(JSON.stringify(next)).toString("base64url") : null }
    } catch { return { status: "blocked", reason: "unavailable" } }
    finally { reply.raw.removeListener("close", abort) }
  })

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/session-history/prune", { bodyLimit: 16_384 }, async (request, reply) => {
    const parsed = pruneBatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid pruning batch" })
    const input = parsed.data
    const manager = deps.workspaceManager, id = request.params.id
    const workspace = manager.get(id), base = manager.getServiceLocation(id)
    if (base && deps.worktreeDeletionFence.isBlocked(base.directory)) return reply.code(409).send({ error: "Worktree deletion is in progress" })
    const fences = [deps.worktreeDeletionFence.captureDisplay(base ? [base.directory] : [])]
    const deadlineAt = Date.now() + 30_000
    const abandoned = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) abandoned.abort() }
    reply.raw.once("close", abort)
    const signal = AbortSignal.any([abandoned.signal, AbortSignal.timeout(30_000)])
    let release: (() => void) | undefined
    try {
      const connection = await manager.getSharedServiceConnection(id)
      if (!connection || !workspace || !base) throw new Error("Workspace unavailable")
      const client = connection.client
      const current = () => {
        signal.throwIfAborted(); connection.assertCurrent()
        if (manager.get(id) !== workspace || manager.getServiceLocation(id) !== base || fences.some(check => !check())) throw new Error("Pruning placement changed")
      }
      current()
      const session = await client.session.get({ sessionID: input.sessionID }, { signal })
      current()
      if (!await manager.ownsLocation(id, session.location, client, signal)) return reply.code(403).send({ error: "Session does not belong to workspace" })
      current()
      const location = readLocationRef(session.location)
      fences.push(deps.worktreeDeletionFence.captureDisplay([location.directory]))
      const identity = await manager.getWorktreeIdentityForPath(id, location.directory)
      current()
      if (!identity) return reply.code(403).send({ error: "Session does not belong to workspace" })
      fences.push(deps.worktreeDeletionFence.captureDisplay([identity]))
      release = deps.worktreeDeletionFence.enter([identity])
      if (!release) return reply.code(409).send({ error: "Worktree deletion is in progress" })
      const revalidate = async () => {
        current()
        const latest = await client.session.get({ sessionID: input.sessionID }, { signal })
        current()
        if (!sameLocation(location, readLocationRef(latest.location)) || !await manager.ownsLocation(id, latest.location, client, signal)) throw new Error("Session moved")
        current()
        return latest
      }
      await manager.desktopPluginsReady({ connection, location: { directory: location.directory }, signal, deadlineAt, assertCurrent: current })
      const latest = await revalidate()
      await assertOrdinaryMissionScheduleSession(client, latest, { signal, current })
      await revalidate()
      current()
      const result = await client.rpc.call({ rpcID: PRUNING_RPC_ID, method: "pruneBatch", input,
        location: { directory: location.directory } },
      { ...locationRequestOptions(location), signal })
      await revalidate()
      const output = pruneBatchResultSchema.parse(result.output)
      if (output.results.length !== input.candidates.length || output.results.some((entry, index) => entry.messageID !== input.candidates[index]?.messageID
        || (entry.result.status === "pruned" && (entry.result.messageID !== entry.messageID
          || entry.result.removedCount !== input.candidates[index]!.toolCount + input.candidates[index]!.reasoningCount)))) throw new Error("Invalid pruning receipt")
      return output
    } catch {
      return { results: input.candidates.map(({ messageID }) => ({ messageID, result: { status: "blocked", reason: "unavailable" } })) }
    } finally { release?.(); reply.raw.removeListener("close", abort) }
  })
}
