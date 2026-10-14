import assert from "node:assert/strict"
import http from "node:http"
import { test } from "node:test"
import Fastify from "fastify"
import replyFrom from "@fastify/reply-from"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import type { Logger } from "../../logger"
import { createRuntimeFetch } from "../../opencode/compatibility/transport"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerInstanceProxyRoutes, type InstanceProxyWorkspaceManager } from "../http-server"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function send(url: string, method = "POST") {
  let request!: http.ClientRequest
  const result = new Promise<number>((resolve, reject) => {
    request = http.request(url, { method, agent: false, headers: { "content-type": "application/json" } }, response => {
      response.resume()
      response.once("end", () => resolve(response.statusCode!))
    })
    request.once("error", reject)
    request.end(method === "POST" ? "{}" : undefined)
  })
  void result.catch(() => undefined)
  return { request, result }
}

type Phase = "connection" | "profile" | "session" | "ownership" | "snapshot" | "environment" | "forward"

async function harness(phase: Phase, nativePreflight = false) {
  const blocked = deferred<void>(), started = deferred<void>(), closed = deferred<void>()
  const cleanupFinished = deferred<void>()
  const nativeClosed = deferred<void>()
  let signal: AbortSignal | undefined
  const calls = { session: 0, snapshot: 0, environment: 0, forward: 0, complete: 0, invalidation: 0 }
  const hold = async (at: Phase, requestSignal?: AbortSignal) => {
    if (phase !== at) return
    signal = requestSignal
    started.resolve()
    // Deliberately ignore cancellation in the fake: the observer must also
    // retire locally and fence continuations from non-cancellable shared work.
    await blocked.promise
  }
  const upstream = Fastify()
  upstream.all("/*", async (request, reply) => {
    if (nativePreflight && request.method === "GET" && request.url === "/api/session/held") {
      reply.raw.once("close", () => nativeClosed.resolve())
      await hold("session")
      return { id: "held", location: { directory: "/repo" } }
    }
    calls.forward++
    await hold("forward")
    calls.complete++
    return { path: request.url }
  })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const upstreamAddress = upstream.server.address()
  assert.ok(upstreamAddress && typeof upstreamAddress === "object")
  const endpoint = `http://127.0.0.1:${upstreamAddress.port}`
  const native = OpenCode.make({ baseUrl: endpoint, fetch: createRuntimeFetch({ url: endpoint }) })
  const client = {
    session: {
      get: async ({ sessionID }: { sessionID: string }, options?: { signal?: AbortSignal }) => {
        calls.session++
        if (nativePreflight && sessionID === "held") return native.session.get({ sessionID }, options)
        if (sessionID !== "witness") await hold("session", options?.signal)
        return { id: sessionID, location: { directory: "/repo" } }
      },
      environment: async (_input: unknown, options?: { signal?: AbortSignal }) => {
        calls.environment++
        await hold("environment", options?.signal)
      },
      instructions: { entry: { remove: async () => {}, put: async () => {} } },
    },
  } as unknown as OpenCodeClient
  const connection = {
    endpoint: { url: endpoint }, client,
    fetch: createRuntimeFetch({ url: endpoint }),
    assertCurrent() {}, invalidate() { calls.invalidation++ },
    profile: async (requestSignal?: AbortSignal) => { await hold("profile", requestSignal); return "modern" as const },
  }
  const manager = {
    get: () => ({ id: "workspace", path: "/repo" }),
    getSharedServiceConnection: async () => { await hold("connection"); return connection },
    getSharedServiceEndpoint: async () => connection.endpoint,
    getSharedServiceClient: async () => client,
    getSharedServiceFetch: async () => connection.fetch,
    getInstanceAuthorizationHeader: () => undefined,
    getServiceDirectory: () => "/repo",
    getServiceDirectoryForPath: async () => "/repo",
    getServicePathForPath: async () => "/repo",
    getWorktreeIdentityForPath: async () => "repo",
    getSessionEnvironment: async (_id: string, requestSignal?: AbortSignal) => {
      calls.snapshot++
      await hold("snapshot", requestSignal)
      return {}
    },
    ownsDirectory: async () => true,
    ownsLocation: async (_id: string, _location: unknown, _client?: unknown, requestSignal?: AbortSignal) => {
      await hold("ownership", requestSignal)
      return true
    },
    ownsPath: async () => true,
  } as unknown as InstanceProxyWorkspaceManager
  const app = Fastify()
  const captured: Array<{ request: http.IncomingMessage; response: http.ServerResponse; abortedListeners: number; closeListeners: number }> = []
  app.addHook("onRequest", async (request, reply) => {
    captured.push({ request: request.raw, response: reply.raw,
      abortedListeners: request.raw.listenerCount("aborted"), closeListeners: reply.raw.listenerCount("close") })
    if (!request.url.endsWith("/witness")) reply.raw.once("close", () => {
      closed.resolve()
      // The admission race settles and disposes in the following microtasks.
      setImmediate(() => cleanupFinished.resolve())
    })
  })
  await app.register(replyFrom)
  const fence = new WorktreeDeletionFence()
  registerInstanceProxyRoutes(app, {
    workspaceManager: manager, worktreeDeletionFence: fence,
    logger: { debug() {}, error() {}, isLevelEnabled() { return false } } as unknown as Logger,
  })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address()
  assert.ok(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}/workspaces/workspace/instance/api/session`
  return {
    base, calls, blocked, started, closed, cleanupFinished, captured, fence, nativeClosed,
    signal: () => signal,
    async dispose() { blocked.resolve(); await app.close(); await upstream.close() },
  }
}

for (const action of ["prompt", "compact"] as const) {
  test(`disconnect cancels actual Promise SDK HTTP preflight for ${action}`, { timeout: 10_000 }, async () => {
    const h = await harness("session", true)
    try {
      const pending = send(`${h.base}/held/${action}`)
      await h.started.promise
      pending.request.destroy()
      await h.nativeClosed.promise
      assert.equal(h.calls.forward, 0)
      assert.equal(h.calls.environment, 0)
      assert.equal(h.calls.invalidation, 0)
    } finally { await h.dispose() }
  })

  test(`disconnect cancels held ${action} session preflight, without blocking another session`, { timeout: 10_000 }, async t => {
    const h = await harness("session")
    try {
      const pending = send(`${h.base}/held/${action}`)
      await h.started.promise
      const witnessStarted = performance.now()
      const witness = await send(`${h.base}/witness`, "GET").result
      t.diagnostic(`another session responded while the preflight was held: ${Math.round(performance.now() - witnessStarted)} ms`)
      assert.equal(witness, 200) // causal independence, not a machine-speed threshold
      pending.request.destroy()
      await h.closed.promise
      await h.cleanupFinished.promise
      assert.equal(h.signal()?.aborted, true)
      h.blocked.resolve()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(h.calls.forward, 1, "only the independent witness reached native forwarding")
      assert.equal(h.calls.environment, 0)
      assert.equal(h.calls.invalidation, 0)
    } finally { await h.dispose() }
  })
}

for (const phase of ["connection", "profile", "ownership", "snapshot", "environment"] as const) {
  test(`disconnect retires a held ${phase} boundary and fences late admission`, { timeout: 10_000 }, async () => {
    const h = await harness(phase)
    try {
      const pending = send(`${h.base}/held/prompt`)
      await h.started.promise
      pending.request.destroy()
      await h.closed.promise
      await h.cleanupFinished.promise
      if (phase !== "connection") assert.equal(h.signal()?.aborted, true)
      const callsAtDisconnect = { ...h.calls }
      h.blocked.resolve()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(h.calls, callsAtDisconnect, "late shared work must not start any subsequent calls")
      assert.equal(h.calls.forward, 0)
      assert.equal(h.calls.invalidation, 0)
      // A preflight-abandoned mutation cannot keep the deletion fence reserved.
      await h.fence.run("repo", ["repo"], async () => {})
      for (const entry of h.captured) {
        assert.equal(entry.request.listenerCount("aborted"), entry.abortedListeners)
        assert.equal(entry.response.listenerCount("close"), entry.closeListeners)
      }
    } finally { await h.dispose() }
  })
}

for (const action of ["prompt", "compact"] as const) {
  test(`disconnect after native ${action} admission does not interrupt, replay or invalidate execution`, { timeout: 10_000 }, async () => {
    const h = await harness("forward")
    try {
      const pending = send(`${h.base}/held/${action}`)
      await h.started.promise
      pending.request.destroy()
      await h.closed.promise
      await h.cleanupFinished.promise
      assert.equal(h.calls.forward, 1)
      h.blocked.resolve()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(h.calls.complete, 1, "the admitted upstream operation can finish after its HTTP observer leaves")
      assert.equal(h.calls.forward, 1)
      assert.equal(h.calls.invalidation, 0)
    } finally { await h.dispose() }
  })
}

test("normal POST body close preserves admission; success and denial dispose admission listeners", { timeout: 10_000 }, async () => {
  const h = await harness("session")
  try {
    const pending = send(`${h.base}/held/compact`)
    await h.started.promise
    assert.equal(h.captured[0].request.complete, true)
    assert.equal(h.signal()?.aborted, false)
    h.blocked.resolve()
    assert.equal(await pending.result, 200)
    assert.equal(await send(`${h.base}/held/not-allowed`).result, 403)
    await new Promise<void>(resolve => setImmediate(resolve))
    for (const entry of h.captured) {
      assert.equal(entry.request.listenerCount("aborted"), entry.abortedListeners)
      // Node's response pipeline retains its own finished-stream callbacks;
      // check our admission/forwarding listeners, not those library internals.
      assert.equal(entry.response.listeners("close").some(listener => ["close", "disconnect"].includes(listener.name)), false)
    }
  } finally { await h.dispose() }
})
