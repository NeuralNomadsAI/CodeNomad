import assert from "node:assert/strict"
import test from "node:test"
import http from "node:http"
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
    onSessionGet?: (callIndex: number, signal?: AbortSignal | null) => Promise<void> | void
  },
) {
  const state = { nativeCalls: [] as string[], directory: "/repo", stale: false, evicted: false, ownsCalls: 0, sessionGets: 0 }
  const logs: string[] = []
  const app = Fastify({ logger: { stream: { write: (text: string) => { logs.push(text) } } } })
  const workspace = {} as NonNullable<ReturnType<UsageRouteDeps["workspaceManager"]["get"]>>
  const nativeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    state.nativeCalls.push(url.pathname)
    if (url.pathname === "/api/session/session") {
      const index = ++state.sessionGets
      await hooks?.onSessionGet?.(index, init?.signal)
      return Response.json({ data: { id: "session", location: { directory: state.directory } } })
    }
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

test("the quota deadline bounds the pre-dispatch session re-read without dispatching the plugin RPC", async t => {
  const realSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
    realSetTimeout(callback, delay === 12_000 ? 25 : delay === 15_000 ? 1_000 : delay, ...args))
  let dispatched = 0
  const { app } = harness(
    async () => { dispatched++; return Response.json({ output: { configured: true, ok: true, windows: {} } }) },
    { onSessionGet: (index, signal) => index === 2 ? new Promise<void>((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })) : undefined },
  )
  try {
    const response = await app.inject(url)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().supported, true)
    assert.equal(response.json().ok, false)
    assert.equal(dispatched, 0)
  } finally { await app.close() }
})

test("a pre-dispatch session re-read that ignores abort still publishes an unavailable quota in time", async t => {
  const realSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
    realSetTimeout(callback, delay === 12_000 ? 25 : delay === 15_000 ? 1_000 : delay, ...args))
  let dispatched = 0
  const { app } = harness(
    async () => { dispatched++; return Response.json({ output: { configured: true, ok: true, windows: {} } }) },
    { onSessionGet: index => index === 2 ? new Promise<void>(() => {}) : undefined },
  )
  try {
    const response = await app.inject(url)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().supported, true)
    assert.equal(response.json().ok, false)
    assert.equal(dispatched, 0)
  } finally { await app.close() }
})

test("provider IDs outside the RPC contract skip the plugin phase and keep the Codex fallback", async t => {
  const realSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
    realSetTimeout(callback, delay === 12_000 ? 25 : delay, ...args))
  // A slow second session read: past the quota deadline it must not turn into a plugin result.
  const { app, state } = harness(
    async () => Response.json({ output: { configured: true, ok: true, windows: {} } }),
    { onSessionGet: (index, signal) => index === 2 ? new Promise<void>((resolve, reject) => {
      realSetTimeout(resolve, 100)
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    }) : undefined },
  )
  try {
    const response = await app.inject("/api/usage/some..provider?instanceId=instance&sessionId=session")
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(state.nativeCalls.some(path => path.startsWith("/api/rpc/")), false)
    assert.equal(response.json().supported, false)
  } finally { await app.close() }
})

test("a client disconnect aborts the plugin RPC without follow-up ownership checks", async () => {
  let started!: () => void
  const rpcStarted = new Promise<void>(resolve => { started = resolve })
  let rpcAborted!: () => void
  const aborted = new Promise<void>(resolve => { rpcAborted = resolve })
  const { app, state } = harness(async (_target, _body, init) => {
    started()
    await new Promise<void>(resolve => init?.signal?.addEventListener("abort", () => resolve(), { once: true }))
    rpcAborted()
    throw init?.signal?.reason
  })
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 })
    const client = new AbortController()
    const request = fetch(`${address}${url}`, { signal: client.signal }).catch(() => undefined)
    await rpcStarted
    client.abort()
    await request
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([aborted, new Promise((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error("RPC not aborted")), 2_000) })])
    } finally { clearTimeout(watchdog) }
    await new Promise(resolve => setTimeout(resolve, 50))
    // Initial read plus the pre-dispatch Location re-read; nothing after the abort.
    assert.equal(state.nativeCalls.filter(path => path === "/api/session/session").length, 2)
  } finally { await app.close() }
})

test("a client that disconnected before the handler started never reaches the plugin RPC", async () => {
  let dispatched = 0
  const { app, state } = harness(async () => { dispatched++; return Response.json({ output: { configured: true, ok: true, windows: {} } }) })
  let entered!: () => void
  const preHandlerEntered = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let handled!: () => void
  const handlerDone = new Promise<void>(resolve => { handled = resolve })
  app.addHook("preHandler", async () => { entered(); await released })
  // onSend runs once the handler has produced its reply, even for a gone client.
  app.addHook("onSend", async () => { handled() })
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 })
    const client = new AbortController()
    const request = fetch(`${address}${url}`, { signal: client.signal }).catch(() => undefined)
    await preHandlerEntered
    client.abort()
    await request
    await new Promise(resolve => setTimeout(resolve, 100))
    release()
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([handlerDone, new Promise((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error("handler never replied")), 2_000) })])
    } finally { clearTimeout(watchdog) }
    assert.equal(state.sessionGets >= 1, true, "the handler ran")
    assert.equal(dispatched, 0)
  } finally { await app.close() }
})

test("an already-expired quota deadline publishes an unavailable quota even if the re-read ignores abort", async t => {
  const realSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
    realSetTimeout(callback, delay === 12_000 ? 25 : delay === 15_000 ? 1_000 : delay, ...args))
  let dispatched = 0
  const { app } = harness(
    async () => { dispatched++; return Response.json({ output: { configured: true, ok: true, windows: {} } }) },
    {
      onOwnsLocation: index => index === 1 ? new Promise<void>(resolve => realSetTimeout(resolve, 60)) : undefined,
      onSessionGet: index => index === 2 ? new Promise<void>(() => {}) : undefined,
    },
  )
  try {
    const response = await app.inject(url)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().supported, true)
    assert.equal(response.json().ok, false)
    assert.equal(dispatched, 0)
  } finally { await app.close() }
})

test("a session moved during the initial ownership check never reaches the plugin RPC", async () => {
  let dispatched = 0
  const { app, state } = harness(
    async () => { dispatched++; return Response.json({ output: { configured: true, ok: true, windows: {} } }) },
    { onOwnsLocation: index => { if (index === 1) state.directory = "/foreign" } },
  )
  try {
    const response = await app.inject(url)
    assert.equal(response.statusCode, 403, response.body)
    assert.equal(dispatched, 0)
  } finally { await app.close() }
})

function codexAliasApp() {
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
  const codexBody = () => ({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: Math.floor(expires / 1000) } } })
  return { app, nativeCalls, codexBody }
}

const codexAliasUrl = "/api/usage/my-codex?instanceId=instance&sessionId=session&modelId=gpt-5"

test("absent plugin RPC falls back to Codex usage when a custom provider alias resolves to openai", async t => {
  const { app, nativeCalls, codexBody } = codexAliasApp()
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    assert.equal(String(input), "https://chatgpt.com/backend-api/wham/usage")
    return Response.json(codexBody())
  })
  try {
    const response = await app.inject(codexAliasUrl)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(nativeCalls.includes("/api/rpc/provider-usage.my-codex/read"), true)
    assert.equal(nativeCalls.includes("/api/provider/my-codex"), true)
    assert.equal(response.json().providerId, "codex")
    assert.equal(response.json().supported, true)
    assert.equal(response.json().ok, true)
    assert.equal(response.json().windows["5h"]?.usedPercent, 20)
  } finally { await app.close() }
})

test("a client disconnect during the Codex fallback leaves the shared read to other clients", async t => {
  const { app, nativeCalls, codexBody } = codexAliasApp()
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let upstream!: () => void
  const upstreamStarted = new Promise<void>(resolve => { upstream = resolve })
  let upstreamCalls = 0
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    upstreamCalls++
    upstream()
    await Promise.race([released, new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))])
    return Response.json(codexBody())
  })
  try {
    const address = new URL(await app.listen({ host: "127.0.0.1", port: 0 }))
    const get = () => {
      const request = http.get({ host: address.hostname, port: address.port, path: codexAliasUrl })
      const body = new Promise<{ status?: number; text: string }>((resolve, reject) => {
        request.on("response", response => {
          let text = ""
          response.setEncoding("utf8").on("data", chunk => { text += chunk }).on("end", () => resolve({ status: response.statusCode, text }))
        }).on("error", reject)
      })
      return { request, body }
    }
    const first = get()
    first.body.catch(() => {})
    await upstreamStarted
    const second = get()
    // Wait until the second client has selected its credential, i.e. joined the in-flight read.
    for (let i = 0; i < 400 && nativeCalls.filter(path => path === "/api/credential").length < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(nativeCalls.filter(path => path === "/api/credential").length, 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    first.request.destroy()
    await new Promise(resolve => setTimeout(resolve, 50))
    release()
    const result = await second.body
    assert.equal(result.status, 200, result.text)
    assert.equal(JSON.parse(result.text).ok, true)
    assert.equal(upstreamCalls, 1, "both clients share one upstream Codex read")
  } finally { await app.close() }
})
