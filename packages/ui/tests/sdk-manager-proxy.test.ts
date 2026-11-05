import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { OpenCode } from "@opencode/client"
import { registerInstanceProxyRoutes } from "../../server/src/server/http-server"
import { EXPLICIT_REQUEST_UNCERTAIN_ERROR_CODE } from "../../server/src/api-types"
import { WorktreeDeletionFence } from "../../server/src/workspaces/worktree-session-evacuation"
import { createInstanceFetch } from "../src/lib/sdk-manager"
import { isSessionActionInterrupted } from "../src/stores/session-action-queue"

test("the real explicit proxy envelope keeps uncertain identity through the product SDK without replay", async () => {
  const app = Fastify(), original = globalThis.fetch
  const workspace = { id: "w", path: "/same", binding: { serverId: "explicit", directory: "/same" } }
  let directory = "/same", sends = 0, envelope: unknown
  const connection = {
    endpoint: { url: "https://upstream.invalid" }, assertCurrent() {}, invalidate() {}, profile: async () => "modern",
    client: { session: { get: async () => ({ id: "s", location: { directory } }) } },
    fetch: async () => { sends++; directory = "/moved"; return Response.json({ data: { id: "accepted" } }) },
  }
  registerInstanceProxyRoutes(app, { logger: pino({ level: "silent" }), worktreeDeletionFence: new WorktreeDeletionFence(),
    workspaceManager: { get: () => workspace, requireWorkspaceCapability: () => new AbortController().signal,
      getSharedServiceConnection: async () => connection } as never })
  try {
    await app.ready()
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      const result = await app.inject({ method: init?.method as "POST", url: url.pathname + url.search,
        payload: init?.body as string, headers: Object.fromEntries(new Headers(init?.headers).entries()) })
      assert.equal(result.statusCode, 502)
      envelope = result.json()
      return new Response(Uint8Array.from(result.rawPayload), { status: result.statusCode, headers: result.headers as Record<string, string> })
    }
    const baseUrl = "http://proxy/workspaces/w/instance/"
    const client = OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) })
    await assert.rejects(client.session.prompt({ sessionID: "s", text: "once" }), error => {
      assert.equal((error as any).cause.code, EXPLICIT_REQUEST_UNCERTAIN_ERROR_CODE)
      assert.equal(isSessionActionInterrupted(error), true)
      return true
    })
    assert.deepEqual(envelope, { error: EXPLICIT_REQUEST_UNCERTAIN_ERROR_CODE,
      message: "Explicit OpenCode request unavailable; do not replay uncertain mutations" })
    assert.equal(sends, 1)
  } finally { globalThis.fetch = original; await app.close() }
})
