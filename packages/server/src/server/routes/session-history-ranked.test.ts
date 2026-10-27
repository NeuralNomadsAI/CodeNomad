import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { registerSessionHistoryRoutes } from "./session-history"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

const url = "/api/workspaces/w/session-history/ranked"
const payload = { version: 1, query: "needle", limit: 20 }
function page(directory = "/repo", id = "s") {
  return { version: 1, status: "ranked", scanned: 1, candidates: 1, judged: 1, skipped: 0, prefilterBypassed: 0,
    matchedSessions: 1, capped: false, caps: [], exclusions: [],
    hits: [{ sessionID: id, messageID: id, role: "user", partIndex: 0, kind: "text", excerpt: "needle", createdAt: 1 }],
    sessions: [{ sessionID: id, directory, title: `${id} title`, scanned: 1, candidates: 1, judged: 1, skipped: 0,
      prefilterBypassed: 0, matchedMessages: 1, tools: 0, reasoning: 0 }] }
}
function fixture(options: { root?: string; directories?: string[] } = {}) {
  const app = Fastify(), fence = new WorktreeDeletionFence(), calls: any[] = [], ownership: string[] = []
  let root = options.root ?? "/repo"
  const directories = options.directories ?? [root]
  let handler = async (input: any): Promise<any> => ({ output: page(input.location.directory, input.location.directory) })
  let active: any
  const replace = (reuseClient = false) => {
    const client = reuseClient ? active.client : { location: { get: async ({ location }: any) => location }, rpc: { call: async (input: any, nativeOptions: any) => {
      calls.push({ ...input, nativeOptions }); return handler(input)
    } } }
    const connection = { client, assertCurrent: () => { if (active !== connection) throw new Error("Connection replaced") } }
    active = connection
  }
  replace()
  registerSessionHistoryRoutes(app, { worktreeDeletionFence: fence, workspaceManager: {
    getServiceLocation: () => root ? { directory: root } : undefined,
    getSharedServiceConnection: async () => active,
    getSharedServiceClient: async () => active.client,
    desktopPluginsReady: async () => {},
    getWorktrees: async () => ({ isGitRepo: true, worktrees: directories.map(directory => ({ directory, serviceDirectory: directory, slug: directory, kind: "worktree" })) }),
    getWorktreeIdentityForPath: async (_id: string, directory: string) => `identity:${directory}`,
    ownsLocation: async (_id: string, location: { directory: string; workspaceID?: string }) => { ownership.push(location.directory); return directories.includes(location.directory) && location.workspaceID === undefined },
  } as any })
  return { app, fence, calls, ownership, replace, setRoot: (value: string) => { root = value },
    handle: (value: typeof handler) => { handler = value } }
}

test("ranked route validates all provenance and strips foreign hits, titles, locations and counts", async () => {
  const f = fixture()
  const good = page(), foreign = page("/repo/independent-clone", "clone")
  f.handle(async () => ({ output: { ...good, scanned: 2, candidates: 2, judged: 2, matchedSessions: 2,
    hits: [...good.hits, ...foreign.hits], sessions: [...good.sessions, ...foreign.sessions] } }))
  try {
    const response = (await f.app.inject({ method: "POST", url, payload })).json()
    assert.equal(response.status, "ranked")
    assert.deepEqual(response.hits.map((hit: any) => hit.sessionID), ["s"])
    assert.equal(response.scanned, 1); assert.equal(response.matchedSessions, 1)
    assert.deepEqual(response.exclusions, ["foreign_directory"])
    assert.equal(response.sessions, undefined); assert.equal(response.caps, undefined)
    assert(!JSON.stringify(response).includes("clone")); assert(!JSON.stringify(response).includes("title"))
    assert(f.ownership.includes("/repo/independent-clone"))
    assert.equal(f.calls[0].method, "historyRanked"); assert.equal(f.calls[0].rpcID, "codenomad.session-pruning")
    assert.equal(f.calls[0].input.limit, 20)
  } finally { await f.app.close() }
})

test("ranked route merges disjoint authorized roots without regrouping repeated sessions", async () => {
  const f = fixture({ directories: ["/repo", "/repo/child", "/linked"] })
  f.handle(async input => {
    const output = page(input.location.directory, input.location.directory)
    output.hits.push({ ...output.hits[0], messageID: "second" })
    output.scanned = output.candidates = output.judged = 2
    output.sessions[0].scanned = output.sessions[0].candidates = output.sessions[0].judged = output.sessions[0].matchedMessages = 2
    return { output }
  })
  try {
    const response = (await f.app.inject({ method: "POST", url, payload })).json()
    assert.deepEqual(f.calls.map(call => call.location.directory), ["/linked", "/repo"])
    assert.deepEqual(response.hits.map((hit: any) => hit.sessionID), ["/linked", "/repo", "/linked", "/repo"])
    assert.equal(response.matchedSessions, 2)
    assert.equal(response.cursor, undefined)
  } finally { await f.app.close() }
})

test("method absence is explicit and cached only for its connection, without literal fallback", async () => {
  const f = fixture()
  f.handle(async () => { throw { _tag: "RpcError", type: "rpc.method_not_found" } })
  try {
    for (let n = 0; n < 2; n++) assert.deepEqual((await f.app.inject({ method: "POST", url, payload })).json(), { status: "unsupported" })
    assert.equal(f.calls.length, 1)
    f.replace(true); f.handle(async () => ({ output: page() }))
    assert.equal((await f.app.inject({ method: "POST", url, payload })).json().status, "ranked")
    assert.equal(f.calls.length, 2)
    assert(f.calls.every(call => call.method === "historyRanked"))
  } finally { await f.app.close() }
})

test("unexpected RPC errors and malformed/forged provenance fail closed", async () => {
  const f = fixture()
  try {
    for (const handler of [
      async () => { throw new Error("404 unrelated transport") },
      async () => ({ output: { ...page(), scanned: 999 } }),
      async () => ({ output: { ...page(), hits: [{ ...page().hits[0], sessionID: "invented" }] } }),
      async () => ({ output: { ...page(), sessions: [...page().sessions, ...page().sessions] } }),
    ]) {
      f.handle(handler)
      assert.deepEqual((await f.app.inject({ method: "POST", url, payload })).json(), { status: "blocked", reason: "unavailable" })
    }
  } finally { await f.app.close() }
})

test("ranked read cannot survive connection/root changes or delete-and-unblock ABA", async () => {
  for (const action of ["connection", "root", "deletion"] as const) {
    const f = fixture()
    f.handle(async () => {
      if (action === "connection") f.replace()
      else if (action === "root") f.setRoot("/different")
      else await f.fence.run("identity:/repo", ["identity:/repo"], async () => {})
      return { output: page() }
    })
    try { assert.equal((await f.app.inject({ method: "POST", url, payload })).json().status, "blocked", action) }
    finally { await f.app.close() }
  }
})

test("ranked reads reject active deletion and invented input scope", async () => {
  const f = fixture()
  try {
    for (const extra of [{ sessionID: "s" }, { directory: "/other" }, { cursor: "x" }, { sql: "select" }, { limit: 21 }, { version: 2 }]) {
      assert.equal((await f.app.inject({ method: "POST", url, payload: { ...payload, ...extra } })).statusCode, 400)
    }
    await f.fence.run("/repo", ["/repo"], async () => {
      assert.equal((await f.app.inject({ method: "POST", url, payload })).json().status, "blocked")
    })
    assert.equal(f.calls.length, 0)
  } finally { await f.app.close() }
})

test("WSL service directories remain exact and native cancellation is propagated", async () => {
  const root = "/home/user/Projet ÉTÉ", f = fixture({ root })
  try {
    const response = (await f.app.inject({ method: "POST", url, payload })).json()
    assert.equal(response.status, "ranked")
    assert.equal(f.calls[0].location.directory, root)
    assert(f.calls[0].nativeOptions.signal instanceof AbortSignal)
    assert(f.ownership.every(directory => directory === root))
  } finally { await f.app.close() }
})

test("disconnecting the authenticated read cancels its native RPC signal", async () => {
  const f = fixture(), controller = new AbortController()
  let began!: () => void, observed!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  const cancelled = new Promise<void>(resolve => { observed = resolve })
  f.handle(async () => {
    began()
    await new Promise<void>(resolve => f.calls[0].nativeOptions.signal.addEventListener("abort", () => { observed(); resolve() }, { once: true }))
    return { output: page() }
  })
  try {
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 })
    const pending = fetch(`${address}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal })
    await started; controller.abort()
    await assert.rejects(pending, /abort/i)
    await cancelled
    assert.equal(f.calls[0].nativeOptions.signal.aborted, true)
  } finally { controller.abort(); await f.app.close() }
})
