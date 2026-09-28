import { createHash } from "node:crypto"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { locationRequestOptions, readLocationRef } from "../../opencode/compatibility/location"
import { PRUNING_RPC_ID } from "../../opencode/session-pruning/contract"
import { historyQuerySchema, historyNativeResultSchema, pruneBatchSchema, pruneBatchResultSchema } from "../../opencode/session-pruning/history-contract"

export interface HistoryRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "getSharedServiceClient" | "ownsLocation" | "getWorktreeIdentityForPath" | "getServiceLocation" | "getWorktrees">
  worktreeDeletionFence: WorktreeDeletionFence
}
const cursorSchema = z.object({ directory: z.string().max(4096), page: z.string().max(4096).optional(), binding: z.string().length(64) }).strict()
const normalized = (directory: string) => (/^[A-Za-z]:[\\/]|^\\\\/.test(directory) ? directory.replaceAll("\\", "/") : directory).replace(/\/$/, "")

export function registerSessionHistoryRoutes(app: FastifyInstance, deps: HistoryRouteDeps) {
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/session-history/query", { bodyLimit: 16_384 }, async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid history query" })
    const input = parsed.data
    const manager = deps.workspaceManager
    const root = manager.getServiceLocation(request.params.id)
    if (!root) return reply.code(404).send({ error: "Workspace not found" })
    const client = await manager.getSharedServiceClient()
    const session = input.sessionID ? await client.session.get({ sessionID: input.sessionID }) : undefined
    if (session && !await manager.ownsLocation(request.params.id, session.location, client)) return reply.code(403).send({ error: "Session does not belong to workspace" })
    // Only native/validated local worktrees supply query locations. A cursor
    // selects from this freshly authorized inventory; it never grants authority.
    const directories = session ? [session.location.directory] : Array.from(new Set([
      root.directory, ...(await manager.getWorktrees(request.params.id, "validated")).worktrees.map(w => w.serviceDirectory).filter((d): d is string => Boolean(d)),
    ])).sort().filter((directory, _i, all) => !all.some(other => other !== directory && normalized(directory).startsWith(`${normalized(other)}/`)))
    const binding = createHash("sha256").update(JSON.stringify([request.params.id, input.sessionID, input.query, input.includeTechnical, input.purpose, directories])).digest("hex")
    let cursor: z.infer<typeof cursorSchema> | undefined
    try {
      cursor = input.cursor ? cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString())) : undefined
      if (cursor && (cursor.binding !== binding || !directories.includes(cursor.directory))) throw new Error("Stale cursor")
    } catch { return reply.code(400).send({ error: "Invalid history cursor" }) }
    const index = cursor ? directories.indexOf(cursor.directory) : 0
    const directory = directories[index]
    if (!directory) return reply.code(404).send({ error: "History location not found" })
    const location = session ? readLocationRef(session.location) : directory === root.directory ? root
      : readLocationRef(await client.location.get({ location: { directory } }))
    if (location.directory !== directory || !await manager.ownsLocation(request.params.id, location, client)) {
      return reply.code(403).send({ error: "History location does not belong to workspace" })
    }
    try {
      const result = await client.rpc.call({ rpcID: PRUNING_RPC_ID, method: "history",
        input: JSON.parse(JSON.stringify({ ...input, cursor: cursor?.page })), location: { directory } },
      { ...locationRequestOptions(location), signal: AbortSignal.timeout(15_000) })
      const output = historyNativeResultSchema.parse(result.output)
      if (output.status !== "page") return output
      // Validate every contributing directory against local Git ownership, not
      // just its lexical ancestor or native project ID. Never expose provenance
      // or counts/excerpts from an independent nested clone to the browser.
      const owned = [] as typeof output.sessions
      for (const candidate of output.sessions) {
        if (input.sessionID && candidate.sessionID !== input.sessionID) throw new Error("Invalid history owner")
        if (await manager.ownsLocation(request.params.id, readLocationRef(candidate), client)) owned.push(candidate)
      }
      const ownedIDs = new Set(owned.map(candidate => candidate.sessionID))
      const next = output.cursor ? { directory, page: output.cursor, binding }
        : directories[index + 1] ? { directory: directories[index + 1], binding } : undefined
      return { status: "page", scanned: owned.reduce((n, owner) => n + owner.scanned, 0),
        tools: owned.reduce((n, owner) => n + owner.tools, 0), reasoning: owned.reduce((n, owner) => n + owner.reasoning, 0),
        skipped: owned.reduce((n, owner) => n + owner.skipped, 0),
        hits: output.hits.filter(hit => ownedIDs.has(hit.sessionID)),
        candidates: input.sessionID && ownedIDs.has(input.sessionID) ? output.candidates : [],
        cursor: next ? Buffer.from(JSON.stringify(next)).toString("base64url") : null }
    } catch { return { status: "blocked", reason: "unavailable" } }
  })

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/session-history/prune", { bodyLimit: 16_384 }, async (request, reply) => {
    const parsed = pruneBatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid pruning batch" })
    const input = parsed.data
    const client = await deps.workspaceManager.getSharedServiceClient()
    const session = await client.session.get({ sessionID: input.sessionID })
    if (!await deps.workspaceManager.ownsLocation(request.params.id, session.location, client)) return reply.code(403).send({ error: "Session does not belong to workspace" })
    const identity = await deps.workspaceManager.getWorktreeIdentityForPath(request.params.id, session.location.directory)
    if (!identity) return reply.code(403).send({ error: "Session does not belong to workspace" })
    const release = deps.worktreeDeletionFence.enter([identity])
    if (!release) return reply.code(409).send({ error: "Worktree deletion is in progress" })
    try {
      const result = await client.rpc.call({ rpcID: PRUNING_RPC_ID, method: "pruneBatch", input,
        location: { directory: session.location.directory } },
      { ...locationRequestOptions(readLocationRef(session.location)), signal: AbortSignal.timeout(30_000) })
      const output = pruneBatchResultSchema.parse(result.output)
      if (output.results.length !== input.candidates.length || output.results.some((entry, index) => entry.messageID !== input.candidates[index]?.messageID
        || (entry.result.status === "pruned" && (entry.result.messageID !== entry.messageID
          || entry.result.removedCount !== input.candidates[index]!.toolCount + input.candidates[index]!.reasoningCount)))) throw new Error("Invalid pruning receipt")
      return output
    } catch {
      return { results: input.candidates.map(({ messageID }) => ({ messageID, result: { status: "blocked", reason: "unavailable" } })) }
    } finally { release() }
  })
}
