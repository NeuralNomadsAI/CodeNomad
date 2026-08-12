import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createInstanceClient } from "./instance-client"
import type { WorkspaceManager } from "./manager"

/**
 * Minimal stand-in for the parts of {@link WorkspaceManager} the factory reads.
 * The factory only touches three members, so a structural stub is enough and
 * keeps the test free of the full manager's heavy dependencies.
 */
interface StubWorkspaceManager {
  getInstancePort: (id: string) => number | undefined
  getInstanceAuthorizationHeader: (id: string) => string | undefined
  get: (id: string) => { path: string } | undefined
}

function makeManager(overrides: Partial<StubWorkspaceManager> = {}): StubWorkspaceManager {
  return {
    getInstancePort: overrides.getInstancePort ?? (() => undefined),
    getInstanceAuthorizationHeader: overrides.getInstanceAuthorizationHeader ?? (() => undefined),
    get: overrides.get ?? (() => undefined),
  }
}

interface CapturedRequest {
  url: string
  headers: Headers
}

/**
 * Installs a global `fetch` stub that records every outgoing request and
 * answers a minimal healthy JSON body. Returns the capture buffer and a
 * restore function. The stub tolerates both `fetch(url, init)` and
 * `fetch(Request)` invocation styles so it is independent of the SDK's
 * internal call convention.
 */
function installRecordingFetch(): { requests: CapturedRequest[]; restore: () => void } {
  const requests: CapturedRequest[] = []
  const original = globalThis.fetch

  globalThis.fetch = (async (input: any, init: any) => {
    if (input instanceof Request) {
      requests.push({ url: input.url, headers: new Headers(init?.headers ?? input.headers) })
    } else {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
    }
    return new Response(JSON.stringify({ healthy: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch

  return { requests, restore: () => { globalThis.fetch = original } }
}

describe("createInstanceClient", () => {
  it("returns null when the instance has no open port", () => {
    const manager = makeManager({ getInstancePort: () => undefined })
    assert.equal(createInstanceClient(manager as unknown as WorkspaceManager, "ws-1"), null)
  })

  it("targets the loopback host and port on outgoing requests", async () => {
    const { requests, restore } = installRecordingFetch()
    try {
      const manager = makeManager({ getInstancePort: () => 4321, get: () => ({ path: "/repo" }) })
      const client = createInstanceClient(manager as unknown as WorkspaceManager, "ws-1")
      assert.ok(client, "expected a client when the instance has a port")

      await client!.global.health()
      const parsed = new URL(requests[0].url)
      assert.equal(parsed.hostname, "127.0.0.1")
      assert.equal(parsed.port, "4321")
    } finally {
      restore()
    }
  })

  it("attaches the authorization header when one is configured", async () => {
    const { requests, restore } = installRecordingFetch()
    try {
      const manager = makeManager({
        getInstancePort: () => 4321,
        getInstanceAuthorizationHeader: () => "Basic abc",
        get: () => ({ path: "/repo" }),
      })
      const client = createInstanceClient(manager as unknown as WorkspaceManager, "ws-1")

      await client!.global.health()
      assert.equal(requests[0].headers.get("authorization"), "Basic abc")
    } finally {
      restore()
    }
  })

  it("omits the authorization header when none is configured", async () => {
    const { requests, restore } = installRecordingFetch()
    try {
      const manager = makeManager({ getInstancePort: () => 4321, get: () => ({ path: "/repo" }) })
      const client = createInstanceClient(manager as unknown as WorkspaceManager, "ws-1")

      await client!.global.health()
      assert.equal(requests[0].headers.get("authorization"), null)
    } finally {
      restore()
    }
  })

  it("scopes requests to the workspace directory", async () => {
    const { requests, restore } = installRecordingFetch()
    try {
      const manager = makeManager({ getInstancePort: () => 4321, get: () => ({ path: "/repo" }) })
      const client = createInstanceClient(manager as unknown as WorkspaceManager, "ws-1")

      await client!.global.health()
      // GET requests carry directory as a query parameter (see SDK rewrite).
      assert.equal(new URL(requests[0].url).searchParams.get("directory"), "/repo")
    } finally {
      restore()
    }
  })

  it("does not scope requests when the workspace has no path", async () => {
    const { requests, restore } = installRecordingFetch()
    try {
      const manager = makeManager({ getInstancePort: () => 4321, get: () => undefined })
      const client = createInstanceClient(manager as unknown as WorkspaceManager, "ws-1")

      await client!.global.health()
      assert.equal(new URL(requests[0].url).searchParams.get("directory"), null)
    } finally {
      restore()
    }
  })

  it("honours an explicit directory override over the workspace root", async () => {
    const { requests, restore } = installRecordingFetch()
    try {
      const manager = makeManager({ getInstancePort: () => 4321, get: () => ({ path: "/workspace-root" }) })
      const client = createInstanceClient(manager as unknown as WorkspaceManager, "ws-1", {
        directory: "/explicit/session-dir",
      })

      await client!.global.health()
      assert.equal(new URL(requests[0].url).searchParams.get("directory"), "/explicit/session-dir")
    } finally {
      restore()
    }
  })

  it("applies the loopback timeout and aborts a stuck instance", { timeout: 1_000 }, async () => {
    const original = globalThis.fetch
    const keepEventLoopAlive = setTimeout(() => {}, 2_000)
    // Never resolves on its own; only settles when the passed signal aborts,
    // mirroring how a real fetch honours an AbortSignal. Without the factory
    // timeout this call would hang forever and time the test out.
    globalThis.fetch = (async (_input: any, init: any) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal
        if (!signal) return
        if (signal.aborted) reject((signal as AbortSignal).reason ?? new Error("aborted"))
        else signal.addEventListener("abort", () => reject((signal as AbortSignal).reason ?? new Error("aborted")))
      })
    }) as typeof fetch
    try {
      const manager = makeManager({ getInstancePort: () => 4321, get: () => ({ path: "/repo" }) })
      const client = createInstanceClient(manager as unknown as WorkspaceManager, "ws-1", { timeoutMs: 10 })

      // SDK methods resolve with { error } rather than throwing by default.
      const result = await client!.global.health()
      assert.ok(result.error, "expected the stuck-instance call to surface an error")
    } finally {
      clearTimeout(keepEventLoopAlive)
      globalThis.fetch = original
    }
  })

  it("preserves the SDK Request signal while retaining the fallback timeout", async () => {
    const originalFetch = globalThis.fetch
    let effectiveSignal: AbortSignal | null | undefined
    globalThis.fetch = ((_input, init) => {
      effectiveSignal = init?.signal
      return new Promise<Response>((_resolve, reject) => effectiveSignal?.addEventListener("abort", () => reject(effectiveSignal?.reason), { once: true }))
    }) as typeof fetch
    try {
      const manager = makeManager({ getInstancePort: () => 4321, get: () => ({ path: "/repo" }) })
      const client = createInstanceClient(manager as unknown as WorkspaceManager, "ws-1", { timeoutMs: 1_000 })!
      const controller = new AbortController()
      const request = client.tool.ids(undefined, { signal: controller.signal })
      while (!effectiveSignal) await new Promise((resolve) => setImmediate(resolve))
      const reason = new Error("caller cancelled")
      controller.abort(reason)
      assert.equal(effectiveSignal.aborted, true)
      assert.strictEqual(effectiveSignal.reason, reason)
      await request.catch(() => undefined)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("preserves a caller signal that is aborted before dispatch", { timeout: 1_000 }, async () => {
    const originalFetch = globalThis.fetch
    let effectiveSignal: AbortSignal | null | undefined
    globalThis.fetch = ((_input, init) => {
      effectiveSignal = init?.signal
      if (effectiveSignal?.aborted) return Promise.reject(effectiveSignal.reason)
      return new Promise<Response>((_resolve, reject) => effectiveSignal?.addEventListener("abort", () => reject(effectiveSignal?.reason), { once: true }))
    }) as typeof fetch
    try {
      const manager = makeManager({ getInstancePort: () => 4321, get: () => ({ path: "/repo" }) })
      const client = createInstanceClient(manager as unknown as WorkspaceManager, "ws-1", { timeoutMs: 1_000 })!
      const controller = new AbortController()
      const reason = new Error("cancelled before dispatch")
      controller.abort(reason)
      await client.tool.ids(undefined, { signal: controller.signal }).catch(() => undefined)
      assert.equal(effectiveSignal?.aborted, true)
      assert.strictEqual(effectiveSignal?.reason, reason)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("times out requests even when the Request carries its default signal", { timeout: 1_000 }, async () => {
    const originalFetch = globalThis.fetch
    let effectiveSignal: AbortSignal | null | undefined
    globalThis.fetch = ((_input, init) => {
      effectiveSignal = init?.signal
      return new Promise<Response>((_resolve, reject) => effectiveSignal?.addEventListener("abort", () => reject(effectiveSignal?.reason), { once: true }))
    }) as typeof fetch
    try {
      const manager = makeManager({ getInstancePort: () => 4321, get: () => ({ path: "/repo" }) })
      const request = createInstanceClient(manager as unknown as WorkspaceManager, "ws-1", { timeoutMs: 5 })!.tool.ids()
      while (!effectiveSignal?.aborted) await new Promise((resolve) => setTimeout(resolve, 1))
      assert.equal(effectiveSignal.reason?.name, "TimeoutError")
      await request.catch(() => undefined)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
