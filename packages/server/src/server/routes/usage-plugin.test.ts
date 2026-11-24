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
  const nativeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
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
  }
  const client = OpenCode.make({ baseUrl: "http://isolated-native.invalid", fetch: nativeFetch })
  const connection = {
    endpoint: { url: "http://isolated-native.invalid" },
    fetch: nativeFetch,
    client,
    assertCurrent: () => { if (state.stale) throw new Error("stale connection") },
  } as ServiceConnection
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

test("plugin provider-usage RPC serves validated quota without reading credentials or provider settings", async () => {
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
    assert.equal(state.nativeCalls.some(path => path.startsWith("/api/provider/")), false)
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

test("workspace eviction during initial or final ownership check blocks dispatch and publication", async () => {
  // Eviction during the initial ownsLocation await must prevent any plugin RPC call and return 403.
  {
    let rpcCalls = 0
    const { app, state } = harness(
      async () => {
        rpcCalls++
        return Response.json({ output: { configured: true, ok: true, windows: { "5h": { usedPercent: 10 } } } })
      },
      {
        onOwnsLocation: (index) => {
          if (index === 1) state.evicted = true
        },
      },
    )
    try {
      const response = await app.inject(url)
      assert.equal(response.statusCode, 403)
      assert.equal(rpcCalls, 0)
    } finally { await app.close() }
  }

  // Eviction during the final ownsLocation await must reject publication with 403.
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

  // Eviction scheduled two microtasks after the second ownsLocation resolves must still block
  // both the absent-RPC Codex fallback and successful quota publication.
  for (const mode of ["absent", "success"] as const) {
    const { app, state } = harness(
      async () => mode === "absent"
        ? Response.json({ _tag: "RpcError", type: "rpc.unavailable", message: "missing" }, { status: 400 })
        : Response.json({ output: { configured: true, ok: true, windows: { "5h": { usedPercent: 10, remainingPercent: 90 } } } }),
      {
        onOwnsLocation: (index) => {
          if (index === 2) {
            queueMicrotask(() => queueMicrotask(() => { state.evicted = true }))
          }
        },
      },
    )
    try {
      const response = await app.inject(url)
      assert.equal(response.statusCode, 403, mode)
      if (mode === "absent") {
        assert.equal(state.nativeCalls.some(path => path.startsWith("/api/provider/")), false)
        assert.equal(state.nativeCalls.includes("/api/credential"), false)
      }
    } finally { await app.close() }
  }
})

test("route preserves HTTP status: generic 404 degrades to supported=false while 400/500/transport fail with 503", async () => {
  for (const responseFactory of [
    () => Response.json({ type: "not_found", message: "Not found" }, { status: 404 }),
    () => Response.json({ _tag: "NotFound", message: "Not found" }, { status: 404 }),
    () => new Response("Not Found", { status: 404 }),
  ]) {
    const { app } = harness(async () => responseFactory())
    try {
      const response = await app.inject(url)
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.json().supported, false)
      assert.equal(response.json().ok, false)
    } finally { await app.close() }
  }

  for (const responder of [
    async () => new Response("Internal Server Error: secret-upstream-500", { status: 500 }),
    async () => Response.json({}, { status: 400 }),
    async () => Response.json({ _tag: "LocationNotFoundError", message: "gone" }, { status: 404 }),
    async () => { throw new TypeError("fetch failed: secret-upstream-host") },
  ]) {
    const { app, logs } = harness(responder)
    try {
      const response = await app.inject(url)
      assert.equal(response.statusCode, 503)
      assert.equal(response.body.includes("secret-upstream"), false)
      assert.equal(logs.join("\n").includes("secret-upstream"), false)
    } finally { await app.close() }
  }
})

test("ownership loss during absent plugin RPC blocks Codex-alias fallback before reading provider or credentials", async () => {
  for (const mutation of ["move", "evict"] as const) {
    let started!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const { app, state } = harness(async () => {
      started()
      await gate
      return Response.json({ _tag: "RpcError", type: "rpc.unavailable", message: "missing" }, { status: 400 })
    })
    try {
      const pending = app.inject(url)
      await entered
      if (mutation === "move") state.directory = "/foreign"
      else state.evicted = true
      release()
      const response = await pending
      assert.equal(response.statusCode, 403)
      assert.equal(state.nativeCalls.some(path => path.startsWith("/api/provider/")), false)
      assert.equal(state.nativeCalls.includes("/api/credential"), false)
    } finally {
      release()
      await app.close()
    }
  }
})

test("expired plugin quota timer after RPC 404 still returns supported=false when outer deadline is live", async t => {
  const realSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
    realSetTimeout(callback, delay === 12_000 ? 25 : delay, ...args))
  const { app } = harness(
    async () => Response.json({}, { status: 404 }),
    { onProviderGet: async () => { await new Promise(resolve => realSetTimeout(resolve, 60)) } },
  )
  try {
    const response = await app.inject(url)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().supported, false)
    assert.equal(response.json().ok, false)
  } finally { await app.close() }
})

test("absent plugin RPC falls back to Codex usage when a custom provider alias resolves to openai", async t => {
  const expires = Date.now() + 3_600_000
  const nativeCalls: string[] = []
  const app = Fastify()
  const workspace = {} as NonNullable<ReturnType<UsageRouteDeps["workspaceManager"]["get"]>>
  const nativeFetch: typeof fetch = async (input) => {
    const target = new URL(input instanceof Request ? input.url : String(input))
    nativeCalls.push(target.pathname)
    if (target.pathname === "/api/session/session") return Response.json({ data: { id: "session", location: { directory: "/repo" } } })
    if (target.pathname === "/api/rpc/provider-usage.my-codex/read") {
      return Response.json({ _tag: "RpcError", type: "rpc.unavailable", message: "RPC is unavailable" }, { status: 400 })
    }
    if (target.pathname === "/api/provider/my-codex") {
      return Response.json({ location: { directory: "/repo" }, data: { id: "my-codex", name: "My Codex", activation: "auto", package: "my-codex", integrationID: "openai" } })
    }
    if (target.pathname === "/api/integration/openai") {
      return Response.json({ location: { directory: "/repo" }, data: { id: "openai", name: "OpenAI", methods: [], connections: [{ type: "credential", method: "oauth", id: "cred_1", label: "Work" }] } })
    }
    if (target.pathname === "/api/credential") {
      return Response.json({ data: [{ id: "cred_1", integrationID: "openai", active: true, label: "Work", value: { type: "oauth", methodID: "chatgpt-headless", access: "secret-access", refresh: "secret-refresh", expires, metadata: { accountID: "acct_1" } } }] })
    }
    return Response.json({}, { status: 404 })
  }
  const client = OpenCode.make({ baseUrl: "http://isolated-native.invalid", fetch: nativeFetch })
  const connection = { endpoint: { url: "http://isolated-native.invalid" }, fetch: nativeFetch, client, assertCurrent: () => {} } as ServiceConnection
  const manager: UsageRouteDeps["workspaceManager"] = {
    get: id => id === "instance" ? workspace : undefined,
    getSharedServiceConnection: async () => connection,
    ownsLocation: async (_id, location) => location.directory === "/repo",
    getSessionEnvironment: async () => ({}),
    getServiceWslDistro: () => undefined,
    getHostPathForServicePath: async () => undefined,
  }
  const freeUsage = createOpenCodeFreeUsage()
  registerUsageRoutes(app, { workspaceManager: manager, freeUsage })
  app.addHook("onClose", async () => { freeUsage.dispose() })
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    assert.equal(String(input), "https://chatgpt.com/backend-api/wham/usage")
    return Response.json({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: Math.floor(expires / 1000) } } })
  })
  try {
    const response = await app.inject("/api/usage/my-codex?instanceId=instance&sessionId=session&modelId=gpt-5")
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(nativeCalls.includes("/api/rpc/provider-usage.my-codex/read"), true)
    assert.equal(nativeCalls.includes("/api/provider/my-codex"), true)
    assert.equal(response.json().providerId, "codex")
    assert.equal(response.json().supported, true)
    assert.equal(response.json().ok, true)
    assert.equal(response.json().windows["5h"]?.usedPercent, 20)
  } finally { await app.close() }
})
