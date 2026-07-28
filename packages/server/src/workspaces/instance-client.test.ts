import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { WorkspaceManager } from "./manager"
import { createInstanceClient } from "./instance-client"

const workspaceManager = {
  getInstancePort: () => 4321,
  getInstanceAuthorizationHeader: () => undefined,
  get: () => ({ id: "workspace", path: "C:/workspace", status: "ready" }),
} as unknown as WorkspaceManager

describe("instance client fetch cancellation", () => {
  it("preserves the SDK Request signal while retaining the fallback timeout", async () => {
    const originalFetch = globalThis.fetch
    let effectiveSignal: AbortSignal | null | undefined
    globalThis.fetch = ((_input, init) => {
      effectiveSignal = init?.signal
      return new Promise<Response>((_resolve, reject) => effectiveSignal?.addEventListener("abort", () => reject(effectiveSignal?.reason), { once: true }))
    }) as typeof fetch
    try {
      const client = createInstanceClient(workspaceManager, "workspace", { timeoutMs: 1_000 })!
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

  it("times out requests even when the Request carries its default signal", async () => {
    const originalFetch = globalThis.fetch
    let effectiveSignal: AbortSignal | null | undefined
    globalThis.fetch = ((_input, init) => {
      effectiveSignal = init?.signal
      return new Promise<Response>((_resolve, reject) => effectiveSignal?.addEventListener("abort", () => reject(effectiveSignal?.reason), { once: true }))
    }) as typeof fetch
    try {
      const request = createInstanceClient(workspaceManager, "workspace", { timeoutMs: 5 })!.tool.ids()
      while (!effectiveSignal?.aborted) await new Promise((resolve) => setTimeout(resolve, 1))
      assert.equal(effectiveSignal.reason?.name, "TimeoutError")
      await request.catch(() => undefined)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
