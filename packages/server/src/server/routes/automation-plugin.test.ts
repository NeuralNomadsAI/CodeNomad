import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { AUTOMATION_BRIDGE_PATH } from "../../opencode/automation-plugin"
import { registerAutomationPluginRoute } from "./automation-plugin"

test("fences developer automation by owned session and forwards CDP actions", async () => {
  const app = Fastify({ logger: false })
  const nativeCalls: Array<{ method: string; params: unknown }> = []
  let state = "ready"
  let runId = "run-1"
  let inspectedIdentity: unknown
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true },
    bridgeToken: "secret",
    nativeParent: {
      request: async (method: string, params: unknown) => {
        nativeCalls.push({ method, params })
        if (method === "developer.restart") {
          runId = "run-2"
          return { state: "starting", runId }
        }
        return {
          status: { state, runId, cdpUrl: "http://127.0.0.1:9222", targetId: "page-1" },
          logs: [{ stream: "system", message: "ready" }],
        }
      },
    },
    developerCdp: {
      inspect: async (identity: unknown) => {
        inspectedIdentity = identity
        return { target: { id: "page-1", title: "CodeNomad", url: "http://app.test/" }, nodes: [], diagnostics: [] }
      },
      close: () => undefined,
    },
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "D:\\project" } }) } }),
      list: () => [{ id: "workspace-1" }],
      ownsLocation: async () => true,
    },
  } as never)

  const request = async (body: Record<string, unknown>) => app.inject({
    method: "POST",
    url: AUTOMATION_BRIDGE_PATH,
    headers: { "x-codenomad-automation-token": "secret" },
    payload: body,
  })

  assert.equal((await request({ mode: "location", directory: "D:\\project", workspaceID: "workspace-1" })).statusCode, 200)
  assert.equal((await request({ mode: "developer-probe", sessionID: "session-1" })).statusCode, 200)
  const inspect = await request({ mode: "developer-execute", sessionID: "session-1", command: { action: "inspect" } })
  assert.equal(inspect.statusCode, 200)
  assert.deepEqual(inspectedIdentity, { endpoint: "http://127.0.0.1:9222", runId: "run-1", targetId: "page-1" })
  assert.deepEqual(inspect.json().result.logs, [{ stream: "system", message: "ready" }])

  state = "error"
  const restart = await request({ mode: "developer-execute", sessionID: "session-1", command: { action: "restart" } })
  assert.equal(restart.statusCode, 200)
  assert.deepEqual(nativeCalls.slice(-2), [
    { method: "developer.status", params: {} },
    { method: "developer.restart", params: {} },
  ])
  assert.equal((await request({ mode: "developer-probe", sessionID: "session-2" })).statusCode, 409)

  state = "stopped"
  assert.equal((await request({ mode: "developer-probe", sessionID: "session-2" })).statusCode, 404)
  state = "ready"
  runId = "run-3"
  assert.equal((await request({ mode: "developer-probe", sessionID: "session-2" })).statusCode, 200)

  const unauthorized = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH, payload: { mode: "developer-probe", sessionID: "session-1" } })
  assert.equal(unauthorized.statusCode, 401)
  await app.close()
})
