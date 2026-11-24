import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { OpenCode } from "@opencode/client"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { registerUsageRoutes, type UsageRouteDeps } from "./usage"
import { createOpenCodeFreeUsage } from "../../usage/opencode-free-usage"

function harness(
  rpcHandler: (url: URL, body: unknown, init?: RequestInit) => Promise<Response>,
  hooks?: {
    onProviderGet?: () => Promise<void> | void
    onOwnsLocation?: (callIndex: number) => Promise<void> | void
  },
) {
  const state = { nativeCalls: [] as string[], directory: "/repo", stale: false, evicted: false, ownsCalls: 0 }
  const logs: string[] = []
  const app = Fastify({ logger: { stream: { write: (text: string) => { logs.push(text) } } } })
  const workspace = {} as NonNullable<ReturnType<UsageRouteDeps["workspaceManager"]["get"]>>
  const client = OpenCode.make({
    baseUrl: "http://isolated-native.invalid",
    fetch: async (input, init) => {
      const url = new URL(String(input))
      state.nativeCalls.push(url.pathname)
      if (url.pathname === "/api/session/session") return Response.json({ data: { id: "session", location: { directory: state.directory } } })
      if (url.pathname.startsWith("/api/provider/")) {
        await hooks?.onProviderGet?.()
        const id = decodeURIComponent(url.pathname.split("/")[3])
        return Response.json({ location: { directory: state.directory }, data: { id, name: id, activation: "auto", package: id } })
      }
      if (url.pathname.startsWith("/api/rpc/")) {
        const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined
        return rpcHandler(url, body, init)
      }
      return Response.json({}, { status: 404 })
    },
  })
  const connection = { client, assertCurrent: () => { if (state.stale) throw new Error("stale connection") } } as ServiceConnection
  const manager: UsageRouteDeps["workspaceManager"] = {
    get: id => id === "instance" && !state.evicted ? workspace : undefined,
    getSharedServiceConnection: async () => connection,
    ownsLocation: async (_id, location) => {
      const index = ++state.ownsCalls
      await hooks?.onOwnsLocation?.(index)
      return location.directory === "/repo"
    },
    getSessionEnvironment: async () => ({}),
    getServiceWslDistro: () => undefined,
    getHostPathForServicePath: async () => undefined,
  }
  const freeUsage = createOpenCodeFreeUsage()
  registerUsageRoutes(app, { workspaceManager: manager, freeUsage })
  app.addHook("onClose", async () => { freeUsage.dispose() })
  return { app, state, logs }
}

const url = "/api/usage/agy-agent?instanceId=instance&sessionId=session&modelId=gemini-4-neon"

test("plugin provider-usage RPC serves validated quota without reading credentials", async () => {
  let received: { pathname: string; directory: string | null; body: unknown } | undefined
  const { app, state } = harness(async (target, body) => {
    received = { pathname: target.pathname, directory: target.searchParams.get("location[directory]"), body }
    return Response.json({
      output: {
        providerName: "Antigravity Agent",
        configured: true,
        ok: true,
        fetchedAt: 1_795_478_400_000,
        windows: {
          "5h": { usedPercent: 9.42, remainingPercent: 90.58, windowSeconds: 18_000, resetAt: 1_795_496_400_000 },
          weekly: { usedPercent: 2.35, remainingPercent: 97.65, windowSeconds: 604_800, resetAt: 1_796_083_200_000 },
        },
      },
    })
  })
  try {
    const response = await app.inject(url)
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(received, {
      pathname: "/api/rpc/provider-usage.agy-agent/read",
      directory: "/repo",
      body: { input: { modelId: "gemini-4-neon" } },
    })
    assert.equal(state.nativeCalls.includes("/api/credential"), false)
    assert.deepEqual(response.json(), {
      requestedProviderId: "agy-agent",
      providerId: "agy-agent",
      providerName: "Antigravity Agent",
      modelId: "gemini-4-neon",
      supported: true,
      configured: true,
      ok: true,
      fetchedAt: 1_795_478_400_000,
      windows: {
        "5h": { usedPercent: 9.42, remainingPercent: 90.58, windowSeconds: 18_000, resetAt: 1_795_496_400_000 },
        weekly: { usedPercent: 2.35, remainingPercent: 97.65, windowSeconds: 604_800, resetAt: 1_796_083_200_000 },
      },
    })
  } finally { await app.close() }
})

test("missing plugin provider-usage RPC falls back to supported=false", async () => {
  const { app } = harness(async () =>
    Response.json({ _tag: "RpcError", type: "rpc.unavailable", message: "RPC is unavailable" }, { status: 400 }),
  )
  try {
    const response = await app.inject(url)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().supported, false)
    assert.equal(response.json().ok, false)
    assert.deepEqual(response.json().windows, {})
  } finally { await app.close() }
})

test("non-conforming plugin output reports unavailable without leaking details", async () => {
  const { app, logs } = harness(async () =>
    Response.json({ output: { providerName: "secret\nleak", configured: true, ok: true, windows: {} } }),
  )
  try {
    const response = await app.inject(url)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().supported, true)
    assert.equal(response.json().ok, false)
    assert.deepEqual(response.json().windows, {})
    assert.equal(response.body.includes("secret"), false)
    assert.equal(logs.join("\n").includes("secret"), false)
  } finally { await app.close() }
})

test("session movement and reconnect fence publication of plugin provider usage", async () => {
  for (const change of ["move", "reconnect"] as const) {
    let started!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const { app, state } = harness(async () => {
      started()
      await gate
      return Response.json({
        output: {
          providerName: "Antigravity Agent",
          configured: true,
          ok: true,
          windows: { "5h": { usedPercent: 10, remainingPercent: 90, windowSeconds: 18_000, resetAt: null } },
        },
      })
    })
    try {
      const pending = app.inject(url)
      await entered
      if (change === "move") state.directory = "/foreign"
      else state.stale = true
      release()
      assert.equal((await pending).statusCode, change === "move" ? 403 : 503)
    } finally {
      release()
      await app.close()
    }
  }
})

test("workspace eviction during alias probe blocks plugin dispatch and eviction during final ownership check blocks publication", async () => {
  // Eviction during the Codex-alias probe must prevent any plugin RPC call and return 403.
  {
    let rpcCalls = 0
    const { app, state } = harness(
      async () => {
        rpcCalls++
        return Response.json({ output: { configured: true, ok: true, windows: { "5h": { usedPercent: 10 } } } })
      },
      { onProviderGet: () => { state.evicted = true } },
    )
    try {
      const response = await app.inject(url)
      assert.equal(response.statusCode, 403)
      assert.equal(rpcCalls, 0)
    } finally { await app.close() }
  }

  // Eviction during the final ownsLocation await must still reject publication with 403.
  {
    const { app, state } = harness(
      async () => Response.json({
        output: { configured: true, ok: true, windows: { "5h": { usedPercent: 10, remainingPercent: 90 } } },
      }),
      {
        onOwnsLocation: (index) => {
          if (index === 2) state.evicted = true
        },
      },
    )
    try {
      const response = await app.inject(url)
      assert.equal(response.statusCode, 403)
    } finally { await app.close() }
  }
})

test("route degrades 404 JSON not_found to supported=false and fails transport errors with 503", async () => {
  {
    const { app } = harness(async () =>
      Response.json({ type: "not_found", message: "Not found" }, { status: 404 }),
    )
    try {
      const response = await app.inject(url)
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.json().supported, false)
      assert.equal(response.json().ok, false)
    } finally { await app.close() }
  }

  {
    const { app, logs } = harness(async () => {
      throw new TypeError("fetch failed: secret-upstream-host")
    })
    try {
      const response = await app.inject(url)
      assert.equal(response.statusCode, 503)
      assert.equal(response.body.includes("secret-upstream-host"), false)
      assert.equal(logs.join("\n").includes("secret-upstream-host"), false)
    } finally { await app.close() }
  }
})
