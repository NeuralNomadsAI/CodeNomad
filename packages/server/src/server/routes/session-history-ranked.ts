import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { decodeRankedCursor, encodeRankedCursor } from "../../opencode/session-pruning/history-ranked-cursor"
import { historyRankedInputSchema, historyRankedResultSchema, type HistoryRankedPage } from "../../opencode/session-pruning/history-ranked-contract"
import { PRUNING_RPC_ID } from "../../opencode/session-pruning/contract"
import { locationRequestOptions, readLocationRef, sameLocation } from "../../opencode/compatibility/location"
import { captureDisplayIdentities } from "../../workspaces/worktree-display-identity"
import { historyDirectories, ownedHistorySessions } from "./session-history-scope"
import { rankedHistoryPageSchema } from "./session-history-ranked-contract"
import type { HistoryRouteDeps } from "./session-history"

const MAX_LOCATIONS = 32
const cursorSchema = z.object({ examined: z.number().int().nonnegative().safe(),
  pages: z.array(z.object({ index: z.number().int().min(0).max(MAX_LOCATIONS - 1), page: z.string().min(1).max(1024) }).strict()).min(1).max(MAX_LOCATIONS) }).strict()
const missingMethod = (error: unknown) => {
  const value = error as { _tag?: unknown; type?: unknown } | null
  return value?._tag === "RpcError" && value.type === "rpc.method_not_found"
}

export function registerRankedHistoryRoute(app: FastifyInstance, deps: HistoryRouteDeps) {
  // Method recognition belongs to the authenticated connection, never a version label.
  const unsupported = new WeakSet<object>()
  const connectionIDs = new WeakMap<object, string>()
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/session-history/ranked", { bodyLimit: 65_536 }, async (request, reply) => {
    const parsed = historyRankedInputSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid ranked history query" })
    const id = request.params.id, manager = deps.workspaceManager
    const base = manager.getServiceLocation(id)
    if (!base) return reply.code(404).send({ error: "Workspace not found" })
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
    reply.raw.once("close", abort)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
    try {
      const connection = await manager.getSharedServiceConnection?.(id)
      if (!connection) return { status: "blocked", reason: "unavailable" }
      const client = connection.client
      const fences: Array<() => boolean> = [deps.worktreeDeletionFence.captureDisplay([base.directory])]
      const current = () => {
        signal.throwIfAborted(); connection.assertCurrent()
        const location = manager.getServiceLocation(id)
        if (!location || !sameLocation(base, location) || fences.some(check => !check())) throw new Error("History location changed")
      }
      current()
      await manager.desktopPluginsReady(); current()
      if (!await manager.ownsLocation(id, base, client, signal)) return reply.code(403).send({ error: "History location does not belong to workspace" })
      current()
      if (unsupported.has(connection)) return { status: "unsupported" }
      const directories = await historyDirectories(manager, id, base.directory); current()
      const selected = directories.slice(0, MAX_LOCATIONS)
      if (!connectionIDs.has(connection)) connectionIDs.set(connection, randomUUID())
      const binding = ["ranked-broker-1", id, base.directory, base.workspaceID, directories, connectionIDs.get(connection), parsed.data.query,
        parsed.data.includeTechnical, parsed.data.since, parsed.data.until, parsed.data.limit]
      let continuation: z.infer<typeof cursorSchema> | undefined
      try {
        continuation = parsed.data.cursor ? cursorSchema.parse(decodeRankedCursor(binding, parsed.data.cursor)) : undefined
        if (continuation && (new Set(continuation.pages.map(page => page.index)).size !== continuation.pages.length
          || continuation.pages.some(page => !selected[page.index]))) throw new Error("Invalid history location cursor")
      } catch { return reply.code(400).send({ error: "Invalid ranked history cursor" }) }
      fences.push((await captureDisplayIdentities(deps.worktreeDeletionFence, manager, id, selected))!); current()
      const owners = new Map<string, HistoryRankedPage["sessions"][number]>()
      const ranked: Array<{ hit: HistoryRankedPage["hits"][number]; rank: number; location: number }> = []
      const exclusions = new Set<HistoryRankedPage["exclusions"][number]>()
      let capped = selected.length < directories.length
      const next: z.infer<typeof cursorSchema>["pages"] = []
      for (const [index, directory] of selected.entries()) {
        const cursor = continuation?.pages.find(page => page.index === index)?.page
        if (continuation && !cursor) continue
        const location = directory === base.directory ? base : readLocationRef(await client.location.get({ location: { directory } }, { ...locationRequestOptions({ directory }), signal }))
        current()
        if (location.directory !== directory || !await manager.ownsLocation(id, location, client, signal)) return reply.code(403).send({ error: "History location does not belong to workspace" })
        current()
        let response
        try {
          const { cursor: _cursor, ...options } = parsed.data
          response = await client.rpc.call({ rpcID: PRUNING_RPC_ID, method: "historyRanked", input: { ...options, ...(cursor ? { cursor } : {}), limit: 40 }, location: { directory } },
            { ...locationRequestOptions(location), signal })
        } catch (error) {
          current()
          if (missingMethod(error)) { unsupported.add(connection); return { status: "unsupported" } }
          throw error
        }
        current()
        const output = historyRankedResultSchema.parse(response.output)
        if (output.status !== "ranked") return output
        if (output.cursor) next.push({ index, page: z.string().max(1024).parse(output.cursor) })
        if (new Set(output.sessions.map(owner => owner.sessionID)).size !== output.sessions.length) throw new Error("Duplicate history provenance")
        for (const key of ["scanned", "candidates", "judged", "skipped", "prefilterBypassed"] as const) {
          if (output[key] !== output.sessions.reduce((sum, owner) => sum + owner[key], 0)) throw new Error("Invalid history counts")
        }
        if (output.matchedSessions !== output.sessions.filter(owner => owner.matchedMessages > 0).length
          || output.hits.some(hit => !output.sessions.some(owner => owner.sessionID === hit.sessionID && owner.matchedMessages > 0))) throw new Error("Invalid history matches")
        if (new Set(output.hits.map(hit => JSON.stringify([hit.sessionID, hit.messageID]))).size !== output.hits.length
          || output.sessions.some(owner => owner.matchedMessages > owner.judged || owner.judged > owner.candidates || owner.candidates > owner.scanned
            || output.hits.filter(hit => hit.sessionID === owner.sessionID).length > owner.matchedMessages)) throw new Error("Invalid history hit counts")
        const owned = await ownedHistorySessions(manager, id, client, output.sessions, undefined, current, signal)
        if (owned.length !== output.sessions.length) exclusions.add("foreign_directory")
        fences.push((await captureDisplayIdentities(deps.worktreeDeletionFence, manager, id, owned.map(owner => owner.directory)))!); current()
        const ownedIDs = new Set(owned.map(owner => owner.sessionID))
        for (const owner of owned) {
          if (owners.has(owner.sessionID)) throw new Error("History session moved between locations")
          owners.set(owner.sessionID, owner)
        }
        output.hits.forEach((hit, rank) => { if (ownedIDs.has(hit.sessionID)) ranked.push({ hit, rank, location: index }) })
        output.exclusions.forEach(reason => exclusions.add(reason))
        capped ||= output.capped
      }
      // Preserve each native list's rank, interleaving disjoint roots by ordinal.
      // Diversity remains visible across the complete project before filling repeats.
      ranked.sort((a, b) => a.rank - b.rank || a.location - b.location)
      const seen = new Set<string>(), first: typeof ranked = [], rest: typeof ranked = []
      for (const entry of ranked) {
        if (seen.has(entry.hit.sessionID)) rest.push(entry)
        else { seen.add(entry.hit.sessionID); first.push(entry) }
      }
      const sessions = await ownedHistorySessions(manager, id, client, [...owners.values()], undefined, current, signal)
      if (sessions.length !== owners.size) exclusions.add("foreign_directory")
      const finalIDs = new Set(sessions.map(owner => owner.sessionID))
      if (!await manager.ownsLocation(id, base, client, signal)) throw new Error("History ownership changed")
      current()
      const scanned = sessions.reduce((sum, owner) => sum + owner.scanned, 0)
      const examinedBefore = continuation?.examined ?? 0
      return rankedHistoryPageSchema.parse({ version: 1, status: "ranked", capped, exclusions: [...exclusions],
        examinedBefore, cursor: next.length ? encodeRankedCursor(binding, { examined: examinedBefore + scanned, pages: next }) : null,
        scanned, candidates: sessions.reduce((sum, owner) => sum + owner.candidates, 0),
        judged: sessions.reduce((sum, owner) => sum + owner.judged, 0), skipped: sessions.reduce((sum, owner) => sum + owner.skipped, 0),
        prefilterBypassed: sessions.reduce((sum, owner) => sum + owner.prefilterBypassed, 0), matchedSessions: sessions.filter(owner => owner.matchedMessages > 0).length,
        hits: [...first, ...rest].filter(entry => finalIDs.has(entry.hit.sessionID)).slice(0, parsed.data.limit).map(entry => entry.hit) })
    } catch { return { status: "blocked", reason: "unavailable" } }
    finally { reply.raw.removeListener("close", abort) }
  })
}
