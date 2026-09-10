import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { registerSessionPruningRoutes } from "./session-pruning"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

const payload = { sessionID: "s", messageID: "m", revision: "a".repeat(64), indexes: [0] }
const url = "/api/workspaces/w/session-pruning/prune"
function fixture(options: { owned?: boolean; output?: unknown; fail?: boolean } = {}) {
  const calls: any[] = []
  const app = Fastify()
  const fence = new WorktreeDeletionFence()
  registerSessionPruningRoutes(app, { worktreeDeletionFence: fence, workspaceManager: {
    getSharedServiceClient: async () => ({
      session: { get: async () => ({ location: { directory: "/owned/worktree" } }) },
      rpc: { call: async (input: unknown, opts: any) => {
        assert(opts.signal instanceof AbortSignal)
        calls.push(input)
        if (options.fail) throw new Error("plugin unavailable")
        return { output: options.output ?? { status: "blocked", reason: "maintenance_required" } }
      } },
    }) as any,
    ownsLocation: async () => options.owned !== false,
    getWorktreeIdentityForPath: async () => "/owned/worktree",
  } })
  return { app, calls, fence }
}

test("broker pins RPC, method and native session location", async () => {
  const { app, calls } = fixture()
  try {
    const response = await app.inject({ method: "POST", url, payload })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { status: "blocked", reason: "maintenance_required" })
    assert.deepEqual(calls, [{ rpcID: "codenomad.session-pruning", method: "prune", input: payload, location: { directory: "/owned/worktree" } }])
  } finally { await app.close() }
})

test("rejects unowned sessions before any RPC", async () => {
  const { app, calls } = fixture({ owned: false })
  try {
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 403)
    assert.equal(calls.length, 0)
  } finally { await app.close() }
})

test("rejects caller-selected location, RPC, database and replacement content", async () => {
  const { app, calls } = fixture()
  try {
    for (const extra of [{ location: { directory: "/other" } }, { rpcID: "other" }, { databasePath: "live.db" }, { content: [] }]) {
      assert.equal((await app.inject({ method: "POST", url, payload: { ...payload, ...extra } })).statusCode, 400)
    }
    assert.equal(calls.length, 0)
  } finally { await app.close() }
})

test("does not bypass worktree deletion fence", async () => {
  const { app, calls, fence } = fixture()
  try {
    await fence.run("/owned/worktree", ["/owned/worktree"], async () => {
      assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 409)
    })
    assert.equal(calls.length, 0)
  } finally { await app.close() }
})

test("missing plugin, malformed response, wrong message or count never report success", async () => {
  for (const options of [{ fail: true }, { output: {} }, { output: { status: "pruned", messageID: "other", revision: "a".repeat(64), removedCount: 1 } }, { output: { status: "pruned", messageID: "m", revision: "a".repeat(64), removedCount: 2 } }]) {
    const { app, fence } = fixture(options)
    try {
      const response = await app.inject({ method: "POST", url, payload })
      assert.deepEqual(response.json(), { status: "blocked", reason: "unavailable" })
      await fence.run("/owned/worktree", ["/owned/worktree"], async () => {})
    } finally { await app.close() }
  }
})

test("preview accepts IDs only and uses a distinct fixed RPC method", async () => {
  const { app, calls } = fixture({ output: { status: "preview", revision: "a".repeat(64), liveMutation: false, parts: [] } })
  try {
    const response = await app.inject({ method: "POST", url: url.replace(/prune$/, "preview"), payload: { sessionID: "s", messageID: "m" } })
    assert.equal(response.json().status, "preview")
    assert.equal(calls[0].method, "preview")
  } finally { await app.close() }
})
