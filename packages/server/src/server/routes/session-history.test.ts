import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { registerSessionHistoryRoutes } from "./session-history"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

const page = { status: "page", scanned: 1, tools: 1, reasoning: 0, skipped: 0, hits: [], candidates: [], cursor: null,
  sessions: [{ sessionID: "s", directory: "/repo", scanned: 1, tools: 1, reasoning: 0, skipped: 0 }] }
function fixture(options: { owned?: boolean; cursor?: string | null; output?: unknown } = {}) {
  const app = Fastify()
  const calls: any[] = []
  const fence = new WorktreeDeletionFence()
  registerSessionHistoryRoutes(app, { worktreeDeletionFence: fence, workspaceManager: {
    getServiceLocation: () => ({ directory: "/repo" }),
    getWorktrees: async () => ({ isGitRepo: true, worktrees: [
      { slug: "nested", directory: "/repo/.codenomad/worktrees/a", serviceDirectory: "/repo/.codenomad/worktrees/a", kind: "worktree" },
      { slug: "outside", directory: "/linked", serviceDirectory: "/linked", kind: "worktree" },
    ] }),
    ownsLocation: async (_id, location) => options.owned !== false && ["/repo", "/linked"].includes(location.directory),
    getWorktreeIdentityForPath: async () => "/repo",
    getSharedServiceClient: async () => ({
      session: { get: async () => ({ id: "s", location: { directory: "/repo" } }) },
      location: { get: async ({ location }: any) => location },
      rpc: { call: async (input: unknown) => { calls.push(input); return { output: options.output ?? { ...page, cursor: options.cursor ?? null } } } },
    }) as any,
  } })
  return { app, calls, fence }
}
const queryUrl = "/api/workspaces/w/session-history/query"
test("workspace queries exclude contributions from independent clones even under the authorized directory", async () => {
  const output = { ...page, scanned: 2, tools: 2,
    sessions: [...page.sessions, { ...page.sessions[0], sessionID: "clone", directory: "/repo/independent-clone" }],
    hits: ["s", "clone"].map(sessionID => ({ sessionID, messageID: sessionID, role: "user", partIndex: 0, kind: "text", excerpt: "needle" })),
  }
  const { app } = fixture({ output })
  try {
    const response = (await app.inject({ method: "POST", url: queryUrl, payload: { query: "needle" } })).json()
    assert.equal(response.status, "page")
    assert.equal(response.scanned, 1)
    assert.equal(response.tools, 1)
    assert.deepEqual(response.hits.map((hit: any) => hit.sessionID), ["s"])
    assert.equal(response.sessions, undefined)
    assert(!JSON.stringify(response).includes("clone"))
  } finally { await app.close() }
})
test("workspace history enumerates only validated roots, avoiding nested-worktree double counting", async () => {
  const { app, calls } = fixture()
  try {
    const first = await app.inject({ method: "POST", url: queryUrl, payload: { purpose: "stats" } })
    assert.equal(first.statusCode, 200)
    assert(first.json().cursor)
    const second = await app.inject({ method: "POST", url: queryUrl, payload: { purpose: "stats", cursor: first.json().cursor } })
    assert.equal(second.json().cursor, null)
    assert.deepEqual(calls.map(c => c.location.directory), ["/linked", "/repo"])
    assert(calls.every(c => c.rpcID === "codenomad.session-pruning" && c.method === "history"))
  } finally { await app.close() }
})
test("history rejects foreign sessions, invented roots and changed-query cursor reuse", async () => {
  const { app, calls } = fixture({ cursor: "native-cursor" })
  try {
    for (const extra of [{ directory: "/other" }, { sql: "SELECT * FROM kv" }, { databasePath: "x" }, { location: { directory: "/other" } }]) {
      assert.equal((await app.inject({ method: "POST", url: queryUrl, payload: extra })).statusCode, 400)
    }
    const first = (await app.inject({ method: "POST", url: queryUrl, payload: { sessionID: "s", query: "needle" } })).json()
    assert.equal((await app.inject({ method: "POST", url: queryUrl, payload: { sessionID: "s", query: "other", cursor: first.cursor } })).statusCode, 400)
    const forged = Buffer.from(JSON.stringify({ directory: "/other", binding: "a".repeat(64) })).toString("base64url")
    assert.equal((await app.inject({ method: "POST", url: queryUrl, payload: { cursor: forged } })).statusCode, 400)
    assert.equal(calls.length, 1)
  } finally { await app.close() }
  const foreign = fixture({ owned: false })
  try {
    assert.equal((await foreign.app.inject({ method: "POST", url: queryUrl, payload: { sessionID: "s" } })).statusCode, 403)
    assert.equal(foreign.calls.length, 0)
  } finally { await foreign.app.close() }
})
test("batch pruning preserves deletion fences and validates per-message receipts", async () => {
  const { app, fence, calls } = fixture({ output: { results: [] } })
  const payload = { sessionID: "s", candidates: [{ messageID: "m", revision: "a".repeat(64), toolCount: 1, reasoningCount: 0 }] }
  const url = "/api/workspaces/w/session-history/prune"
  try {
    await fence.run("/repo", ["/repo"], async () => {
      assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 409)
    })
    assert.equal(calls.length, 0)
    const response = (await app.inject({ method: "POST", url, payload })).json()
    assert.deepEqual(response.results, [{ messageID: "m", result: { status: "blocked", reason: "unavailable" } }])
    assert.equal(calls[0].method, "pruneBatch")
    assert.equal((await app.inject({ method: "POST", url, payload: { ...payload, candidates: Array(17).fill(payload.candidates[0]) } })).statusCode, 400)
  } finally { await app.close() }
})
