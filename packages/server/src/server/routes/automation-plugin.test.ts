import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { AUTOMATION_BRIDGE_PATH } from "../../opencode/automation-plugin"
import { registerAutomationPluginRoute } from "./automation-plugin"

test("a slow unrelated workspace cannot hide an already verified automation owner", { timeout: 2_000 }, async t => {
  const app = Fastify()
  let unblock!: () => void
  const unrelated = new Promise<void>(resolve => { unblock = resolve })
  t.after(async () => { unblock(); await app.close() })
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true }, bridgeToken: "fixture", nativeParent: { available: true }, developerCdp: {},
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "/repo" } }) } }),
      list: () => [{ id: "slow-unrelated" }, { id: "owner" }],
      ownsLocation: async (id: string) => { if (id === "owner") return true; await unrelated; return false },
    },
  } as never)
  const response = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
    headers: { "x-codenomad-automation-token": "fixture" }, payload: { mode: "browser-claim", sessionID: "ses_owner" } })
  assert.equal(response.statusCode, 200)
})

test("targets the inspected window independently of the visible conversation", async () => {
  const app = Fastify({ logger: false })
  const nativeCalls: Array<{ method: string; params: unknown }> = []
  let state = "ready"
  let runId = "run-1"
  let visibleSession = "session-1"
  let inspectedIdentity: unknown
  const inspectOptions: unknown[] = [], actions: Array<Record<string, unknown>> = []
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
          status: {
            state,
            runId,
            nativeIdentity: "electron:test",
            cdpUrl: "http://127.0.0.1:9222",
            windowId: "window-1",
          },
          logs: [],
        }
      },
    },
    developerCdp: {
      context: async (identity: { sessionId?: string }) => {
        assert.equal(identity.sessionId, undefined)
        return { windowId: "window-1", instanceId: "workspace-1", sessionId: visibleSession }
      },
      inspect: async (identity: unknown, options: unknown) => {
        inspectedIdentity = identity
        inspectOptions.push(options)
        return {
          target: { id: "page-1", title: "CodeNomad", url: "http://app.test/" },
          context: { windowId: "window-1", instanceId: "workspace-1", sessionId: visibleSession },
          snapshot: "- button \"Save\" [e1]",
          collapsed: 0,
          diagnostics: [],
        }
      },
      close: () => undefined,
      act: async (identity: { sessionId?: string; instanceId?: string }, action: { action: string; values?: string[] }) => {
        assert.equal(identity.sessionId, undefined)
        assert.equal(identity.instanceId, undefined)
        actions.push(action)
        return action.action === "select" ? { selected: action.values } : {}
      },
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

  assert.equal((await request({ mode: "developer-probe", sessionID: "session-1" })).statusCode, 200)
  const inspect = await request({ mode: "developer-execute", sessionID: "session-1", command: { action: "inspect" } })
  assert.equal(inspect.statusCode, 200)
  assert.deepEqual(inspectedIdentity, {
    endpoint: "http://127.0.0.1:9222",
    runId: "run-1",
    windowId: "window-1",
  })
  assert.equal(inspect.json().result.context.sessionId, "session-1")

  visibleSession = "session-2"
  assert.equal((await request({ mode: "developer-execute", sessionID: "session-1", command: { action: "click", ref: "ax1" } })).statusCode, 200)
  assert.equal((await request({ mode: "developer-execute", sessionID: "session-1", command: { action: "inspect", ref: "e1", query: "Save" } })).statusCode, 200)
  assert.deepEqual(inspectOptions, [{ ref: undefined, query: undefined }, { ref: "e1", query: "Save" }])
  const selected = await request({ mode: "developer-execute", sessionID: "session-1", command: { action: "select", ref: "e2", values: ["Exploration"] } })
  assert.deepEqual(selected.json(), { result: { ok: true, selected: ["Exploration"] } })
  await request({ mode: "developer-execute", sessionID: "session-1", command: { action: "type", ref: "e3", text: "x", clear: false } })
  assert.deepEqual(actions.map(action => [action.action, action.ref, action.clear ?? action.values]),
    [["click", "ax1", undefined], ["select", "e2", ["Exploration"]], ["type", "e3", false]])
  assert.equal((await request({ mode: "developer-execute", sessionID: "session-1", command: { action: "press", key: "Hyper+Q" } })).statusCode, 400,
    "the backend validates the flat command again")

  const restart = await request({ mode: "developer-execute", sessionID: "session-1", command: { action: "restart" } })
  assert.equal(restart.statusCode, 200)
  assert.deepEqual(nativeCalls.slice(-2), [
    { method: "developer.status", params: {} },
    { method: "developer.restart", params: {} },
  ])
  assert.equal((await request({ mode: "developer-probe", sessionID: "session-2" })).statusCode, 200)
  assert.equal((await request({ mode: "developer-execute", sessionID: "session-1", command: { action: "restart" } })).statusCode, 404)

  state = "stopped"
  assert.equal((await request({ mode: "developer-probe", sessionID: "session-2" })).statusCode, 404)
  state = "ready"
  runId = "run-3"
  visibleSession = "session-2"
  assert.equal((await request({ mode: "developer-probe", sessionID: "session-2" })).statusCode, 200)

  const unauthorized = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH, payload: { mode: "developer-probe", sessionID: "session-1" } })
  assert.equal(unauthorized.statusCode, 401)
  await app.close()
})

test("browser works with an unavailable developer target and unrelated inventory failure", async () => {
  const app = Fastify({ logger: false })
  const nativeCalls: Array<{ method: string; params: unknown }> = []
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true },
    bridgeToken: "secret",
    nativeParent: {
      available: true,
      request: async (method: string, params: any) => {
        nativeCalls.push({ method, params })
        if (method === "browser.page.begin") return { generation: "preview-document", url: "https://example.com/" }
        if (method === "browser.page.send" && params.method === "Accessibility.getFullAXTree") {
          return { nodes: [{ nodeId: "one", backendDOMNodeId: 42, role: { value: "button" }, name: { value: "Preview action" } }] }
        }
        return method === "developer.status" ? { status: { state: "stopped" } }
          : method === "browser.probe" ? { available: true } : { url: "https://example.com/" }
      },
    },
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "D:\\project" } }) } }),
      list: () => [{ id: "unrelated-worktree" }, { id: "workspace-1" }],
      ownsLocation: async (id: string) => {
        if (id === "unrelated-worktree") throw new Error("Native worktree inventory is unavailable")
        return true
      },
    },
  } as never)

  const request = async (body: Record<string, unknown>) => app.inject({
    method: "POST",
    url: AUTOMATION_BRIDGE_PATH,
    headers: { "x-codenomad-automation-token": "secret" },
    payload: body,
  })

  assert.equal((await request({ mode: "browser-claim", sessionID: "session-1" })).statusCode, 200)
  assert.equal(nativeCalls.length, 0)
  assert.equal((await request({ mode: "browser-probe", sessionID: "session-1" })).statusCode, 200)
  const open = await request({ mode: "browser-execute", sessionID: "session-1", command: { action: "open", url: "https://example.com" } })
  assert.equal(open.statusCode, 200)
  assert.deepEqual(nativeCalls, [
    { method: "browser.probe", params: { sessionID: "session-1" } },
    {
      method: "browser.execute",
      params: { sessionID: "session-1", command: { action: "open", url: "https://example.com" } },
    },
  ])
  const snapshot = await request({ mode: "browser-execute", sessionID: "session-1", command: { action: "snapshot", query: "Preview" } })
  assert.equal(snapshot.statusCode, 200)
  assert.match(snapshot.json().result.snapshot, /- button "Preview action" \[b1e1\]/)
  assert.equal(nativeCalls.at(-1)?.method, "browser.page.end", "browser snapshots now use the shared engine's private channel")
  const count = nativeCalls.length
  assert.equal((await request({ mode: "browser-execute", sessionID: "session-1", command: { action: "protocol", method: "Runtime.evaluate" } })).statusCode, 400)
  assert.equal(nativeCalls.length, count, "a model can never choose protocol methods or scripts")
  const developer = await request({ mode: "developer-execute", sessionID: "session-1", command: { action: "inspect" } })
  assert.equal(developer.statusCode, 404)
  assert.match(developer.json().error, /Native automation has no active/)
  await app.close()
})

test("a backend without a desktop host claims owned sessions for Mission dispatch only", async () => {
  const app = Fastify({ logger: false })
  const nativeCalls: string[] = []
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true },
    bridgeToken: "secret",
    // The real NativeParent of a standalone server: unavailable, every request refused.
    nativeParent: { available: false, request: async (method: string) => {
      nativeCalls.push(method)
      throw new Error("Native control is unavailable in this host")
    } },
    developerCdp: {},
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async ({ sessionID }: { sessionID: string }) =>
        ({ location: { directory: sessionID === "foreign" ? "/foreign" : "/repo" } }) } }),
      list: () => [{ id: "workspace-1" }],
      ownsLocation: async (_id: string, location: { directory: string }) => location.directory === "/repo",
    },
  } as never)
  const request = (body: Record<string, unknown>) => app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
    headers: { "x-codenomad-automation-token": "secret" }, payload: body })

  assert.equal((await request({ mode: "browser-claim", sessionID: "owned", purpose: "mission" })).statusCode, 200)
  const browser = await request({ mode: "browser-claim", sessionID: "owned" })
  assert.equal(browser.statusCode, 404, "the browser tools cannot pick an owner that opens no page")
  assert.match(browser.json().error, /Browser automation is unavailable/)
  assert.equal((await request({ mode: "browser-claim", sessionID: "foreign", purpose: "mission" })).statusCode, 404,
    "ownership is still required for dispatch")
  assert.equal((await request({ mode: "browser-probe", sessionID: "owned" })).statusCode, 404)
  assert.equal((await request({ mode: "developer-probe", sessionID: "owned" })).statusCode, 404)
  assert.deepEqual(nativeCalls, ["browser.probe", "developer.status"], "native requests fail closed without a host")
  await app.close()
})
