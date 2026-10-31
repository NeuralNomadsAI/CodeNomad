import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import { registerSessionGoalRoute } from "./session-goal"

const goal = { id: "g1", objective: "Ship it", status: "paused", reason: "Paused by the user", rounds: 3, maxRounds: 50,
  stalls: 1, boot: "process", updatedAt: 10 }

function fixture() {
  const app = Fastify()
  const state = { owned: true, missing: false, session: { id: "ses_a", location: { directory: "/repo/worktree", workspaceID: "wrk" } } as any,
    answer: (): unknown => ({ output: goal }) }
  const calls: any[] = [], ownership: any[] = []
  registerSessionGoalRoute(app, { workspaceManager: {
    ownsLocation: async (id: string, location: unknown) => { ownership.push({ id, location }); return state.owned },
    getSharedServiceClient: async () => ({
      session: { get: async () => { if (state.missing) throw new Error("not found"); return structuredClone(state.session) } },
      rpc: { call: async (input: any, options: any) => { calls.push({ input, options }); return state.answer() } },
    }) as any,
  } as any })
  const send = (sessionId = "ses_a") => app.inject({ method: "GET", url: `/api/workspaces/w/sessions/${encodeURIComponent(sessionId)}/goal` })
  return { app, state, calls, ownership, send }
}
// The native SDK throws a declared RPC error with its body's fields.
const rpcError = (type: string) => Object.assign(new Error(type), { _tag: "RpcError", type, message: type })

test("reads the Session's goal through the fixed RPC in its own Location after the ownership check", async () => {
  const f = fixture()
  try {
    const response = await f.send()
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["cache-control"], "no-store")
    // Only the displayed fields reach the browser.
    assert.deepEqual(response.json(), { status: "goal", goal: { id: "g1", objective: "Ship it", status: "paused",
      reason: "Paused by the user", rounds: 3, maxRounds: 50, updatedAt: 10 } })
    assert.deepEqual(f.ownership, [{ id: "w", location: { directory: "/repo/worktree", workspaceID: "wrk" } }])
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.calls[0].input, { rpcID: "opencode.goal", method: "get", input: { sessionID: "ses_a" },
      location: { directory: "/repo/worktree" } })
    assert.ok(f.calls[0].options.signal instanceof AbortSignal)
    assert.match(f.calls[0].options.headers["x-codenomad-location"], /worktree/)
    f.state.answer = () => ({ output: null })
    assert.deepEqual((await f.send()).json(), { status: "goal", goal: null })
  } finally { await f.app.close() }
})

test("refuses invalid, missing and foreign sessions before calling the plugin", async () => {
  const f = fixture()
  try {
    for (const id of ["abc", "ses", "ses_a/../b", "ses a"]) {
      assert.equal((await f.send(id)).statusCode, 400, id)
    }
    // Beyond the router's parameter length the route never matches.
    assert.equal((await f.send(`ses_${"x".repeat(600)}`)).statusCode, 404)
    f.state.missing = true
    assert.equal((await f.send()).statusCode, 404)
    f.state.missing = false
    f.state.owned = false
    assert.equal((await f.send()).statusCode, 403)
    assert.equal(f.calls.length, 0)
  } finally { await f.app.close() }
})

test("maps a runtime without the goal RPC to unsupported and every other failure to unavailable", async () => {
  const f = fixture()
  try {
    for (const type of ["rpc.unavailable", "rpc.method_not_found"]) {
      f.state.answer = () => { throw rpcError(type) }
      assert.deepEqual((await f.send()).json(), { status: "unsupported" }, type)
    }
    for (const failure of [() => { throw rpcError("rpc.internal") }, () => { throw new Error("socket hang up") },
      () => ({ output: { ...goal, status: "blocked" } }), () => ({ output: { ...goal, rounds: "3" } }), () => ({})]) {
      f.state.answer = failure
      const response = await f.send()
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json(), { status: "unavailable" })
    }
  } finally { await f.app.close() }
})
