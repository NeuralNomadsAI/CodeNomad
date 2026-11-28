import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { NativeParent, NativeRequestRefused, NATIVE_REQUEST_PREFIX, NATIVE_RESPONSE_PREFIX } from "../../native-parent"
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
    headers: { "x-codenomad-automation-token": "fixture" }, payload: { mode: "browser-claim", sessionID: "ses_owner", purpose: "mission" } })
  assert.equal(response.statusCode, 200, "a supported host can claim a session for mission dispatch")
})

test("targets the exact inspection independently of the visible conversation or another client", async t => {
  const app = Fastify({ logger: false })
  t.after(() => app.close())
  const nativeCalls: Array<{ method: string; params: unknown }> = []
  const closedRuns: string[] = []
  let state = "ready"
  let runId = "run-1"
  let focusedWindow = "window-1"
  let firstWindowOpen = true
  let holdStatus: (() => Promise<void>) | undefined
  let holdRestart: (() => Promise<void>) | undefined
  let disconnectReply: (() => void) | undefined
  let restartFailure: Error | undefined
  let screenshotWindow: string | undefined
  let windowInstance: string | undefined
  let onInspection: (() => void) | undefined
  let visibleSession = "session-1"
  let owned = true
  let originalWindow: "missing" | "ready" = "ready"
  let renderedWindow: string | undefined
  let inspectedIdentity: unknown
  const previewError = { level: "error", text: "browser preview: install navigation starting handler: Paramètre incorrect. (0x80070057)" }
  const inspectOptions: unknown[] = [], actions: Array<Record<string, unknown>> = []
  const deps = {
    authManager: { isLoopbackRequest: () => true },
    bridgeToken: "secret",
    nativeParent: {
      request: async (method: string, params: { windowId?: string; runId?: string; windowInstance?: string; restartId?: string }) => {
        nativeCalls.push({ method, params })
        if (holdStatus && params.windowId === "window-1") {
          const wait = holdStatus
          holdStatus = undefined
          await wait()
        }
        if (method === "developer.restartScope") {
          await holdRestart?.()
          if (restartFailure) throw restartFailure
          return params
        }
        const reconnect = method === "developer.reconnect"
        const windowId = params.windowId ?? focusedWindow
        const available = (!params.runId || params.runId === runId && params.windowInstance === windowInstance)
          && (windowId !== "window-1" || firstWindowOpen)
        return {
          status: {
            state: reconnect ? originalWindow : available ? state : "starting",
            runId,
            nativeIdentity: "electron:test",
            cdpUrl: "http://127.0.0.1:9222",
            windowId: reconnect || available ? windowId : undefined,
            windowInstance,
            ...(reconnect && { restartId: params.restartId }),
          },
          logs: [previewError],
        }
      },
    },
    developerCdp: {
      probeContexts: async (selection: { runId: string }, windows: Map<string, string | undefined>) => {
        assert.equal(selection.runId, runId)
        return new Map(windows)
      },
      context: async (identity: { sessionId?: string; windowId: string }) => {
        assert.equal(identity.sessionId, undefined)
        return { windowId: identity.windowId, instanceId: "workspace-1", sessionId: visibleSession }
      },
      inspect: async (identity: { windowId: string; windowInstance?: string }, options: unknown, hooks?: { beforeRead?(): void }) => {
        hooks?.beforeRead?.()
        onInspection?.()
        inspectedIdentity = identity
        inspectOptions.push(options)
        return {
          target: { id: "page-1", title: "CodeNomad", url: "http://app.test/" },
          context: { windowId: renderedWindow ?? identity.windowId, windowInstance: identity.windowInstance,
            instanceId: "workspace-1", sessionId: visibleSession },
          snapshot: "- button \"Save\" [e1]",
          collapsed: 0,
          diagnostics: [],
        }
      },
      close: (runId: string) => { closedRuns.push(runId) },
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
      ownsLocation: async () => owned,
    },
  } as never
  app.addHook("preHandler", async (req, reply) => {
    if ((req.body as { command?: { restartId?: string } })?.command?.restartId === "f4747d3e-86d2-4c01-8f7a-32489301a945") {
      disconnectReply = () => { reply.raw.emit("close") }
    }
  })
  registerAutomationPluginRoute(app, deps)

  const request = async (body: Record<string, unknown>, server = app) => server.inject({
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

  const target = { runId: "run-1", nativeIdentity: "electron:test", windowId: "window-1" }

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
  assert.equal((await execute({ action: "press", key: "Hyper+Q" }, firstPin)).statusCode, 400,
    "the backend validates the flat command again")
  const command = { ...target, restartId: "8d80a777-0085-48c8-b791-d3514bd63f32" }
  const restartRequest = (command: object, callerPin?: string) =>
    request({ mode: "developer-restart", sessionID: "session-1", command, pin: callerPin })
  const beforeUnpinnedRestart = nativeCalls.length
  const unpinnedRestart = await restartRequest(command)
  assert.equal(unpinnedRestart.statusCode, 404)
  assert.equal(unpinnedRestart.json().code, "inspect-required")
  assert.equal(nativeCalls.length, beforeUnpinnedRestart)
  assert.equal((await restartRequest(command, "incorrect-pin")).statusCode, 409)
  assert.equal((await restartRequest({ ...command, nativeIdentity: "other-scope" }, firstPin)).statusCode, 409)
  assert.equal((await restartRequest({ ...command, runId: "other-run" }, firstPin)).statusCode, 409)
  assert.equal((await restartRequest({ ...command, windowId: "other-window" }, firstPin)).statusCode, 409)
  const restart = await restartRequest(command, firstPin)
  assert.equal(restart.statusCode, 200)
  assert.deepEqual(nativeCalls.slice(-2), [
    { method: "developer.status", params: { windowId: "window-1", runId: "run-1" } },
    { method: "developer.restartScope", params: command },
  ])
  assert.deepEqual(nativeCalls.filter(call => call.method.startsWith("developer.restart")), [{ method: "developer.restartScope", params: command }])
  assert.deepEqual(restart.json().result, command)
  assert.deepEqual(closedRuns, ["run-1"])
  runId = "run-2"
  assert.equal((await request({ mode: "developer-probe", sessionID: "session-2" })).statusCode, 200)
  assert.equal((await restartRequest(command, firstPin)).statusCode, 409)
  assert.equal((await execute({ action: "restart" }, firstPin)).json().code, "target-gone")

  const successor = Fastify()
  registerAutomationPluginRoute(successor, deps)
  const reconnect = () => request({ mode: "developer-reconnect", sessionID: "session-1", command }, successor)
  const newTarget = { ...target, runId: "run-2" }
  const receipt = { developerTarget: newTarget, restartId: command.restartId }
  owned = false
  originalWindow = "missing"
  assert.deepEqual((await reconnect()).json(), { ...receipt, windowState: "missing" })
  originalWindow = "ready"
  assert.deepEqual((await reconnect()).json(), { ...receipt, windowState: "pending" }, "renderer reads still require ownership")
  owned = true
  renderedWindow = "other-focused-window"
  assert.deepEqual((await reconnect()).json(), { ...receipt, windowState: "pending" }, "never publish a different renderer")
  renderedWindow = undefined
  assert.equal((await reconnect()).json().windowState, "inspected")
  const recovered = (await reconnect()).json()
  assert.equal(recovered.windowState, "inspected", "retry the same receipt if its bridge response was lost")
  assert.deepEqual(inspectedIdentity, { runId: "run-2", windowId: "window-1", endpoint: "http://127.0.0.1:9222" })
  const beforeUnpinnedFollowUps = nativeCalls.length
  for (const command of [{ action: "press", key: "Enter" }, { action: "inspect", ref: "e1" }, { action: "screenshot" }]) {
    const response = await request({ mode: "developer-execute", sessionID: "session-1", command }, successor)
    assert.equal(response.json().code, "inspect-required", command.action)
  }
  const noRestartPin = await request({ mode: "developer-restart", sessionID: "session-1",
    command: { ...command, ...newTarget } }, successor)
  assert.equal(noRestartPin.json().code, "inspect-required")
  assert.equal(nativeCalls.length, beforeUnpinnedFollowUps, "a successful reconnect never authorizes implicit follow-ups")
  const press = await request({ mode: "developer-execute", sessionID: "session-1",
    command: { action: "press", key: "Enter" }, pin: recovered.result.pin }, successor)
  assert.equal(press.statusCode, 200)
  assert.deepEqual(nativeCalls.at(-1), { method: "developer.status", params: { runId: newTarget.runId, windowId: newTarget.windowId } })
  await successor.close()

  focusedWindow = "window-1"
  const fresh = await execute({ action: "inspect" })
  assert.equal(fresh.statusCode, 200)
  firstWindowOpen = false
  focusedWindow = "window-2"
  const vanished = await execute({ action: "press", key: "Enter" }, fresh.json().result.pin)
  assert.equal(vanished.statusCode, 404)
  assert.equal(vanished.json().code, "target-gone")
  assert.equal(actions.length, 4, "a vanished window cannot send a key to the newly focused window")

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
  const lostCommand = { nativeIdentity: target.nativeIdentity, runId, windowId: "window-2", windowInstance,
    restartId: "f4747d3e-86d2-4c01-8f7a-32489301a945" }
  restartFailure = new NativeRequestRefused("The selected window is no longer available")
  const refused = await restartRequest(lostCommand, retiringPin)
  assert.equal(refused.statusCode, 409)
  assert.match(refused.json().error, /selected window is no longer available/)
  assert.deepEqual(closedRuns, ["run-1"])
  const anotherInspection = await request({ mode: "developer-execute", sessionID: "session-1",
    target: `electron:test/${runId}/window-2/${windowInstance}`, command: { action: "inspect" } })
  assert.equal(anotherInspection.statusCode, 200)
  const lostPin = anotherInspection.json().result.pin
  restartFailure = new Error("Native request timed out")
  let started!: () => void, releaseRestart!: () => void
  const sent = new Promise<void>(resolve => { started = resolve })
  const nativePending = new Promise<void>(resolve => { releaseRestart = resolve })
  holdRestart = () => { started(); return nativePending }
  const disconnected = assert.rejects(restartRequest(lostCommand, lostPin), { code: "LIGHT_ECONNRESET" })
  try {
    await sent
    disconnectReply!()
    assert.deepEqual(closedRuns, ["run-1", "run-3"], "HTTP disconnect retires the old run before the outstanding native reply")
  } finally { releaseRestart() }
  await disconnected
  assert.deepEqual(closedRuns, ["run-1", "run-3"])
  assert.equal((await restartRequest(lostCommand, lostPin)).statusCode, 409)
  assert.deepEqual(nativeCalls.filter(({ method }) => method.startsWith("developer.restart")), [
    { method: "developer.restartScope", params: command },
    { method: "developer.restartScope", params: lostCommand },
    { method: "developer.restartScope", params: lostCommand },
  ])

  const unauthorized = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH, payload: { mode: "developer-probe", sessionID: "session-1" } })
  assert.equal(unauthorized.statusCode, 401)
})

for (const pauseAt of ["native", "CDP"]) {
  test(`reconnect preserves a newer inspection published during ${pauseAt}`, { timeout: 5_000 }, async t => {
    const app = Fastify()
    let reached!: () => void, resume!: () => void
    const paused = new Promise<void>(resolve => { reached = resolve })
    const resumed = new Promise<void>(resolve => { resume = resolve })
    t.after(async () => { resume(); await app.close() })
    const nativeIdentity = "electron:test", runId = "new-run", restoredWindow = "window-A"
    const focused = "window-B"
    const endpoint = "http://127.0.0.1:9222"
    let restoredReads = 0
    registerAutomationPluginRoute(app, {
      authManager: { isLoopbackRequest: () => true }, bridgeToken: "secret",
      nativeParent: { request: async (method: string, params: { windowId?: string; restartId?: string }) => {
        if (method === "developer.reconnect" && pauseAt === "native") { reached(); await resumed }
        return { status: { state: "ready", nativeIdentity, runId, windowId: params.windowId ?? focused,
          restartId: params.restartId, cdpUrl: endpoint } }
      } },
      developerCdp: {
        context: async () => ({}),
        inspect: async ({ windowId }: { windowId: string }, _options: unknown, hooks?: { beforeRead?(): void }) => {
          hooks?.beforeRead?.()
          if (windowId === restoredWindow) {
            restoredReads++
            if (pauseAt === "CDP") { reached(); await resumed }
          }
          return { context: { windowId }, diagnostics: [] }
        },
        act: async ({ windowId }: { windowId: string }) => ({ windowId }),
      },
      workspaceManager: {
        getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "/repo" } }) } }),
        list: () => [{ id: "owner" }], ownsLocation: async () => true,
      },
    } as never)
    const request = (mode: string, command: object, pin?: string) => app.inject({
      method: "POST", url: AUTOMATION_BRIDGE_PATH, headers: { "x-codenomad-automation-token": "secret" },
      payload: { mode, sessionID: "ses_fixture", command, pin },
    })
    const restartId = "8d80a777-0085-48c8-b791-d3514bd63f32"
    const reconnect = request("developer-reconnect", { nativeIdentity, runId: "old-run", windowId: restoredWindow, restartId })
    await paused
    const inspection = await request("developer-execute", { action: "inspect" })
    assert.equal(inspection.statusCode, 200)
    assert.equal(inspection.json().result.context.windowId, focused)
    resume()
    assert.deepEqual((await reconnect).json(), {
      developerTarget: { nativeIdentity, runId, windowId: restoredWindow }, restartId, windowState: "superseded",
    })
    assert.equal(restoredReads, pauseAt === "native" ? 0 : 1)
    const act = await request("developer-execute", { action: "press", key: "Enter" }, inspection.json().result.pin)
    assert.equal(act.statusCode, 200)
    assert.equal(act.json().result.windowId, focused)
  })
}

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
  assert.deepEqual(strictReads, [true, true])
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
  assert.equal((await request({ mode: "browser-claim", sessionID: "foreign", purpose: "mission" })).statusCode, 404,
    "ownership is still required for dispatch")
  assert.equal((await request({ mode: "browser-probe", sessionID: "owned" })).statusCode, 400)
  assert.equal((await request({ mode: "developer-probe", sessionID: "owned" })).statusCode, 404)
  assert.deepEqual(nativeCalls, ["developer.status"], "preview probes do not query a backend without a native host")
  await app.close()
})
