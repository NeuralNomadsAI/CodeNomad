import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { NativeRequestRefused } from "../../native-parent"
import { AUTOMATION_BRIDGE_PATH } from "../../opencode/automation-plugin"
import { registerAutomationPluginRoute } from "./automation-plugin"

test("a slow unrelated workspace cannot hide an already verified automation owner", { timeout: 2_000 }, async t => {
  const app = Fastify()
  let unblock!: () => void
  const unrelated = new Promise<void>(resolve => { unblock = resolve })
  t.after(async () => { unblock(); await app.close() })
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true }, bridgeToken: "fixture",
    nativeParent: { available: true, request: async (method: string) => {
      assert.equal(method, "browser.probe")
      throw new Error("No visible local browser target for this session")
    } }, developerCdp: {},
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "/repo" } }) } }),
      list: () => [{ id: "slow-unrelated" }, { id: "owner" }],
      ownsLocation: async (id: string) => { if (id === "owner") return true; await unrelated; return false },
    },
  } as never)
  const response = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
    headers: { "x-codenomad-automation-token": "fixture" }, payload: { mode: "browser-claim", sessionID: "ses_owner" } })
  assert.equal(response.statusCode, 200, "a supported host can claim a session before opening its first preview")
})

test("targets the exact inspection independently of the visible conversation or another client", async t => {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  const nativeCalls: Array<{ method: string; params: unknown }> = []
  let state = "ready"
  let runId = "run-1"
  let focusedWindow = "window-1"
  let firstWindowOpen = true
  let holdStatus: (() => Promise<void>) | undefined
  let restartFailure: Error | undefined
  const retiredRuns: string[] = []
  let screenshotWindow: string | undefined
  let windowInstance: string | undefined
  let onInspection: (() => void) | undefined
  let visibleSession = "session-1"
  let inspectedIdentity: unknown
  const previewError = { level: "error", text: "browser preview: install navigation starting handler: Paramètre incorrect. (0x80070057)" }
  const inspectOptions: unknown[] = [], actions: Array<Record<string, unknown>> = []
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true },
    bridgeToken: "secret",
    nativeParent: {
      request: async (method: string, params: { windowId?: string; runId?: string; windowInstance?: string }) => {
        nativeCalls.push({ method, params })
        if (holdStatus && params.windowId === "window-1") {
          const wait = holdStatus
          holdStatus = undefined
          await wait()
        }
        if (method === "developer.restart") {
          if (restartFailure) throw restartFailure
          runId = "run-2"
          return { state: "starting", runId }
        }
        const windowId = params.windowId ?? focusedWindow
        const available = (!params.runId || params.runId === runId && params.windowInstance === windowInstance)
          && (windowId !== "window-1" || firstWindowOpen)
        return {
          status: {
            state: available ? state : "starting",
            runId,
            nativeIdentity: "electron:test",
            cdpUrl: "http://127.0.0.1:9222",
            windowId: available ? windowId : undefined,
            windowInstance,
          },
          logs: [previewError],
        }
      },
    },
    developerCdp: {
      context: async (identity: { sessionId?: string; windowId: string }) => {
        assert.equal(identity.sessionId, undefined)
        return { windowId: identity.windowId, instanceId: "workspace-1", sessionId: visibleSession }
      },
      inspect: async (identity: { windowId: string }, options: unknown) => {
        onInspection?.()
        inspectedIdentity = identity
        inspectOptions.push(options)
        return {
          target: { id: "page-1", title: "CodeNomad", url: "http://app.test/" },
          context: { windowId: identity.windowId, instanceId: "workspace-1", sessionId: visibleSession },
          snapshot: "- button \"Save\" [e1]",
          collapsed: 0,
          diagnostics: [],
        }
      },
      close: (run: string) => retiredRuns.push(run),
      screenshot: async (identity: { windowId: string }) => {
        screenshotWindow = identity.windowId
        return { data: "fixture", mediaType: "image/png" }
      },
      act: async (identity: { sessionId?: string; instanceId?: string; windowId: string }, action: { action: string; values?: string[] }) => {
        assert.equal(identity.sessionId, undefined)
        assert.equal(identity.instanceId, undefined)
        actions.push({ ...action, windowId: identity.windowId })
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
  const execute = (command: Record<string, unknown>, pin?: string) =>
    request({ mode: "developer-execute", sessionID: "session-1", command, pin })

  assert.equal((await request({ mode: "developer-probe", sessionID: "session-1" })).statusCode, 200)
  const inspect = await request({ mode: "developer-execute", sessionID: "session-1", command: { action: "inspect" } })
  assert.equal(inspect.statusCode, 200)
  assert.deepEqual(inspectedIdentity, {
    endpoint: "http://127.0.0.1:9222",
    runId: "run-1",
    windowId: "window-1",
  })
  assert.equal(inspect.json().result.context.sessionId, "session-1")
  assert.deepEqual(inspect.json().result.diagnostics, [previewError], "inspection exposes retained native preview errors")
  const firstPin = inspect.json().result.pin
  assert.ok(firstPin)

  visibleSession = "session-2"
  focusedWindow = "window-2"
  assert.equal((await execute({ action: "click", ref: "ax1" }, firstPin)).statusCode, 200)
  assert.equal((await execute({ action: "screenshot" }, firstPin)).statusCode, 200)
  assert.equal(screenshotWindow, "window-1")
  assert.equal((await execute({ action: "inspect", ref: "e1", query: "Save" }, firstPin)).statusCode, 200)
  assert.deepEqual(inspectOptions, [{ ref: undefined, query: undefined }, { ref: "e1", query: "Save" }])
  const selected = await execute({ action: "select", ref: "e2", values: ["Exploration"] }, firstPin)
  assert.deepEqual(selected.json(), { result: { ok: true, selected: ["Exploration"] } })
  await execute({ action: "type", ref: "e3", text: "x", clear: false }, firstPin)
  assert.deepEqual(actions.map(action => [action.action, action.ref, action.clear ?? action.values]),
    [["click", "ax1", undefined], ["select", "e2", ["Exploration"]], ["type", "e3", false]])
  assert.equal((await request({ mode: "developer-execute", sessionID: "session-1", command: { action: "press", key: "Hyper+Q" } })).statusCode, 400,
    "the backend validates the flat command again")

  const restart = await execute({ action: "restart" }, firstPin)
  assert.equal(restart.statusCode, 200)
  assert.deepEqual(nativeCalls.slice(-2), [
    { method: "developer.status", params: { windowId: "window-1", runId: "run-1" } },
    { method: "developer.restart", params: { windowId: "window-1", runId: "run-1" } },
  ])
  assert.equal((await request({ mode: "developer-probe", sessionID: "session-2" })).statusCode, 200)
  assert.equal((await execute({ action: "restart" }, firstPin)).json().code, "target-gone")

  focusedWindow = "window-1"
  const fresh = await execute({ action: "inspect" })
  assert.equal(fresh.statusCode, 200)
  firstWindowOpen = false
  focusedWindow = "window-2"
  const vanished = await execute({ action: "press", key: "Enter" }, fresh.json().result.pin)
  assert.equal(vanished.statusCode, 404)
  assert.equal(vanished.json().code, "target-gone")
  assert.equal(actions.length, 3, "a vanished window cannot send a key to the newly focused window")

  firstWindowOpen = true
  focusedWindow = "window-1"
  const select = (window: string) => request({ mode: "developer-execute", sessionID: "session-1",
    target: `electron:test/${runId}/${window}`, command: { action: "inspect" } })
  const firstWindow = await select("window-1")
  assert.equal(firstWindow.statusCode, 200)
  let entered!: () => void, release!: () => void
  const statusEntered = new Promise<void>(resolve => { entered = resolve })
  const releaseStatus = new Promise<void>(resolve => { release = resolve })
  holdStatus = () => { entered(); return releaseStatus }
  const expansion = execute({ action: "inspect", ref: "e1" }, firstWindow.json().result.pin)
  await statusEntered
  let secondPin: string
  try {
    const secondWindow = await select("window-2")
    assert.equal(secondWindow.statusCode, 200)
    assert.equal(secondWindow.json().result.context.windowId, "window-2")
    secondPin = secondWindow.json().result.pin
  }
  finally { release() }
  assert.equal((await expansion).json().result.context.windowId, "window-1")

  const beforeRefusal = nativeCalls.length
  for (const command of [{ action: "press", key: "Enter" }, { action: "inspect", ref: "e1" },
    { action: "screenshot" }, { action: "restart" }]) {
    const response = await execute(command)
    assert.equal(response.statusCode, 404, command.action)
    assert.equal(response.json().code, "inspect-required", command.action)
  }
  assert.equal(nativeCalls.length, beforeRefusal, "no command without a receipt reaches the native host")

  assert.equal((await execute({ action: "press", key: "Enter" }, secondPin)).statusCode, 200)
  assert.equal(actions.at(-1)?.windowId, "window-2")
  assert.equal((await execute({ action: "screenshot" }, secondPin)).statusCode, 200)
  assert.equal(screenshotWindow, "window-2", "a late expansion must not switch windows")

  const a = (await select("window-1")).json().result.pin
  let enteredInspection!: () => void, releaseInspection!: () => void
  const reading = new Promise<void>(resolve => { enteredInspection = resolve })
  const paused = new Promise<void>(resolve => { releaseInspection = resolve })
  holdStatus = () => { enteredInspection(); return paused }
  const lateInspection = request({ mode: "developer-execute", sessionID: "session-1", pin: a, command: { action: "inspect" } })
  await reading
  let b: string
  try { b = (await select("window-2")).json().result.pin }
  finally { releaseInspection() }
  assert.equal((await lateInspection).json().code, "stale-inspection")
  const capture = (pin: string) => request({ mode: "developer-execute", sessionID: "session-1", pin, command: { action: "screenshot" } })
  assert.equal((await capture("unissued")).json().code, "target-gone")
  assert.equal((await capture(b)).statusCode, 200)
  assert.equal(screenshotWindow, "window-2")

  windowInstance = "old-window"
  onInspection = () => { windowInstance = "new-window" }
  const replaced = await request({ mode: "developer-execute", sessionID: "session-1",
    target: `electron:test/${runId}/window-1/old-window`, command: { action: "inspect" } })
  assert.equal(replaced.json().code, "target-gone", "closing and reopening a window cannot publish the new outline under the old selector")

  state = "stopped"
  assert.equal((await request({ mode: "developer-probe", sessionID: "session-2" })).statusCode, 404)
  state = "ready"
  runId = "run-3"
  visibleSession = "session-2"
  assert.equal((await request({ mode: "developer-probe", sessionID: "session-2" })).statusCode, 200)
  onInspection = undefined
  const beforeRestart = await request({ mode: "developer-execute", sessionID: "session-1",
    target: `electron:test/${runId}/window-2/${windowInstance}`, command: { action: "inspect" } })
  assert.equal(beforeRestart.statusCode, 200)
  const retiringPin = beforeRestart.json().result.pin
  restartFailure = new NativeRequestRefused("The selected window is no longer available")
  const refused = await execute({ action: "restart" }, retiringPin)
  assert.equal(refused.statusCode, 404)
  assert.equal(refused.json().code, "target-gone")
  assert.deepEqual(retiredRuns, ["run-1"])
  const anotherInspection = await request({ mode: "developer-execute", sessionID: "session-1",
    target: `electron:test/${runId}/window-2/${windowInstance}`, command: { action: "inspect" } })
  assert.equal(anotherInspection.statusCode, 200)
  const lostPin = anotherInspection.json().result.pin
  restartFailure = new Error("Native request timed out")
  const unconfirmed = await execute({ action: "restart" }, lostPin)
  assert.equal(unconfirmed.json().code, "restart-outcome-unknown")
  assert.match(unconfirmed.json().error, /Choose the window.*before retrying/)
  assert.deepEqual(retiredRuns, ["run-1", "run-3"])
  assert.equal((await execute({ action: "restart" }, lostPin)).json().code, "target-gone")
  assert.equal(nativeCalls.filter(({ method }) => method === "developer.restart").length, 3)

  const unauthorized = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH, payload: { mode: "developer-probe", sessionID: "session-1" } })
  assert.equal(unauthorized.statusCode, 401)
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
        if (method === "browser.page.begin") return { generation: "preview-document", url: "https://example.com/", driver: "cdp", contractVersion: 1 }
        if (method === "browser.page.send" && params.operation?.op === "tree") {
          return { nodes: [{ id: "one", node: 42, role: "button", name: "Preview action" }] }
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
  assert.equal(developer.json().code, "no-window")
  await app.close()
})

test("WebKit browser claims, probes and native actions succeed independently of developer CDP", async t => {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  const nativeCalls: string[] = []
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true }, bridgeToken: "secret",
    nativeParent: { available: true, browserAutomationUnavailable: false, request: async (method: string) => {
      nativeCalls.push(method)
      return method === "browser.probe" ? { available: true } : { text: "WebKit native result" }
    } },
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "/repo" } }) } }),
      list: () => [{ id: "owner" }], ownsLocation: async () => true,
    },
  } as never)
  const request = (body: Record<string, unknown>) => app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
    headers: { "x-codenomad-automation-token": "secret" }, payload: { sessionID: "owned", ...body } })

  assert.equal((await request({ mode: "browser-claim", purpose: "mission" })).statusCode, 200)
  assert.deepEqual(nativeCalls, [])
  const claim = await request({ mode: "browser-claim" })
  assert.equal(claim.statusCode, 200)
  assert.deepEqual(nativeCalls, [], "claim can open the first preview without an existing target")
  const probe = await request({ mode: "browser-probe" })
  assert.equal(probe.statusCode, 200)
  assert.equal(probe.json().result.available, true)
  for (const command of [
    { action: "open", url: "https://example.com" }, { action: "navigate", url: "https://example.com" },
    { action: "screenshot" },
  ]) {
    const response = await request({ mode: "browser-execute", command })
    assert.equal(response.statusCode, 200, command.action)
    assert.equal(response.json().result.text, "WebKit native result", command.action)
  }
})

test("Mission preference and preparation claims remain available without browser automation", async t => {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  const strictReads: boolean[] = []
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true }, bridgeToken: "secret",
    nativeParent: { available: true, browserAutomationUnavailable: true },
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "/repo" } }) } }),
      list: () => [{ id: "owner" }],
      ownsLocation: async (_id: string, _location: unknown, _client: unknown, options: { strict: boolean }) => {
        strictReads.push(options.strict)
        return true
      },
    },
  } as never)
  for (const purpose of ["mission-preferences", "mission-prepare"]) {
    const response = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
      headers: { "x-codenomad-automation-token": "secret" }, payload: { mode: "browser-claim", sessionID: "owned", purpose } })
    assert.equal(response.statusCode, 200, purpose)
    assert.deepEqual(response.json(), { result: { available: true, missionCreationDefaults: true, missionPreparationStart: true } })
  }
  const browser = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
    headers: { "x-codenomad-automation-token": "secret" }, payload: { mode: "browser-claim", sessionID: "owned" } })
  assert.equal(browser.statusCode, 409)
  assert.equal(browser.json().code, "unsupported")
  assert.deepEqual(strictReads, [true, true, false])
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
