import assert from "node:assert/strict"
import test from "node:test"

import type { Logger } from "../logger"
import type { WorkspaceManager } from "../workspaces/manager"
import { createOpencodePermissionReplier } from "./opencode-replier"

test("aborts a permission reply when its runtime generation is revoked", async () => {
  const original = globalThis.fetch
  let deadline: ReturnType<typeof setTimeout> | undefined
  let requestSignal: AbortSignal | undefined
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true })
    })
  }) as typeof fetch

  try {
    const workspaceManager = {
      getInstancePort: () => 4321,
      getInstanceAuthorizationHeader: () => undefined,
      get: () => ({ path: "/repo" }),
    } as unknown as WorkspaceManager
    const replier = createOpencodePermissionReplier({ workspaceManager, logger: {} as Logger })
    const controller = new AbortController()
    const reply = replier({
      instanceId: "instance",
      permissionId: "permission",
      sessionId: "session",
      source: "v2",
      reply: "once",
    }, controller.signal)

    await new Promise<void>((resolve) => setImmediate(resolve))
    controller.abort()

    await assert.rejects(Promise.race([
      reply,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Permission reply cancellation test timed out")), 1_000)
      }),
    ]), (error: Error) => error.name === "AbortError")
    assert.equal(requestSignal?.aborted, true)
  } finally {
    if (deadline) clearTimeout(deadline)
    globalThis.fetch = original
  }
})
