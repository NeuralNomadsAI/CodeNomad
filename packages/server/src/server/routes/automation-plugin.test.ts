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
          : method === "browser.probe" ? { available: true, target: "preview-document" } : { url: "https://example.com/" }
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
  const probe = await request({ mode: "browser-probe", sessionID: "session-1" })
  assert.deepEqual(probe.json().result, { available: true, target: "preview-document" })
  const open = await request({ mode: "browser-execute", sessionID: "session-1", command: { action: "open", url: "https://example.com" } })
  assert.equal(open.statusCode, 200)
  assert.deepEqual(nativeCalls, [
    { method: "browser.probe", params: { sessionID: "session-1" } },
    {
      method: "browser.execute",
      params: { sessionID: "session-1", command: { action: "open", url: "https://example.com" } },
    },
  ])
  const snapshot = await request({ mode: "browser-execute", sessionID: "session-1", target: probe.json().result.target, command: { action: "snapshot", query: "Preview" } })
  assert.equal(snapshot.statusCode, 200)
  assert.equal(Reflect.get(nativeCalls[2].params, "target"), "preview-document")
  assert.match(snapshot.json().result.snapshot, /- button "Preview action" \[b\d+e1\]/)
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
      return method === "browser.probe" ? { available: true, target: "webkit-document" } : { text: "WebKit native result" }
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
    const response = await request({ mode: "browser-execute", command, ...(command.action !== "open" ? { target: probe.json().result.target } : {}) })
    assert.equal(response.statusCode, 200, command.action)
    assert.equal(response.json().result.text, "WebKit native result", command.action)
  }
})

test("preview discovery returns explicit evidence of absence and refuses uncertain ownership", async t => {
  const app = Fastify()
  t.after(() => app.close())
  let state: "missing" | "other-missing" | "unauthorized" | "unowned" | "unreadable" | "hidden" | "native-failure" = "missing"
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true }, bridgeToken: "secret",
    nativeParent: { available: true, request: async () => {
      if (state === "hidden") throw new Error("No visible local browser target for this session")
      throw new Error("Native request timed out: browser.probe")
    } },
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async () => {
        if (state === "missing" || state === "other-missing") throw { _tag: "SessionNotFoundError", sessionID: state === "missing" ? "session" : "other" }
        if (state === "unauthorized") throw { status: 401 }
        return { location: { directory: "/repo" } }
      } } }),
      list: () => [{ id: "owner" }],
      ownsLocation: async (_id: string, _location: unknown, _client: unknown, { strict }: { strict?: boolean }) => {
        if (state === "unreadable" && strict) throw new Error("Worktree inventory unavailable")
        return state === "hidden" || state === "native-failure"
      },
    },
  } as never)
  const request = (mode: string) => app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
    headers: { "x-codenomad-automation-token": "secret" }, payload: { mode, sessionID: "session" } })
  for (const mode of ["browser-probe", "browser-claim"]) {
    for (state of ["missing", "unowned"] as const) {
      const response = await request(mode)
      assert.equal(response.statusCode, 404, state)
      assert.equal(response.json().code, "browser-not-owner", state)
    }
    for (state of ["other-missing", "unauthorized", "unreadable"] as const) {
      const response = await request(mode)
      assert.equal(response.statusCode, 503, state)
      assert.equal(response.json().code, "inventory-unavailable", state)
    }
  }
  state = "hidden"
  const hidden = await request("browser-probe")
  assert.equal(hidden.statusCode, 404)
  assert.equal(hidden.json().code, "hidden-preview")
  state = "native-failure"
  const failed = await request("browser-probe")
  assert.equal(failed.statusCode, 503)
  assert.equal(failed.json().code, "browser-unavailable")
})

test("the HTTP preview deadline bounds native probe slots after ownership reads", async t => {
  const app = Fastify()
  const now = Date.now()
  const deadlines: number[] = []
  let dispatched!: () => void
  const entered = new Promise<void>(resolve => { dispatched = resolve })
  const parent = new NativeParent({ write: line => {
    const { method, deadline } = JSON.parse(String(line).slice(NATIVE_REQUEST_PREFIX.length))
    deadlines.push(deadline)
    if (method === "browser.probe" && deadlines.length === 32) dispatched()
    return true
  } }, true, false)
  t.after(async () => { parent.close(); await app.close() })
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now })
  let releaseOwnership!: () => void, checking!: () => void
  const ownership = new Promise<void>(resolve => { releaseOwnership = resolve })
  const checkingOwnership = new Promise<void>(resolve => { checking = resolve })
  let reads = 0
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true }, bridgeToken: "secret", nativeParent: parent,
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "/repo" } }) } }),
      list: () => [{ id: "owner" }], ownsLocation: async () => {
        if (++reads === 33) checking()
        await ownership
        return true
      },
    },
  } as never)
  const probe = (deadline?: number) => app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
    headers: { "x-codenomad-automation-token": "secret" }, payload: { mode: "browser-probe", sessionID: "session", deadline } })
  const pending = Promise.all([probe(), probe(now + 90_000), ...Array.from({ length: 30 }, () => probe(now + 5_000))])
  const expiredWhileChecking = probe(now + 3_000)
  await checkingOwnership
  t.mock.timers.tick(4_000)
  releaseOwnership()
  await entered
  assert.equal((await expiredWhileChecking).json().code, "inventory-unavailable")
  assert.deepEqual(deadlines, Array(32).fill(now + 5_000), "the native envelope retains the HTTP deadline")
  await assert.rejects(parent.request("developer.status", {}), /Too many pending native requests/)
  t.mock.timers.tick(1_000)
  assert.ok((await pending).every(response => response.json().code === "browser-unavailable"))
  const next = assert.rejects(parent.request("developer.status", {}), /shutting down/)
  assert.equal(deadlines.length, 33, "the native channel has a free slot at the HTTP deadline")
  parent.close()
  await next
  const expired = await probe(now + 5_000)
  assert.equal(expired.json().code, "inventory-unavailable")
  assert.equal(deadlines.length, 33)
})

test("browser execution stops waiting at its HTTP deadline during each ownership read", async t => {
  const stages = ["service", "session", "ownership"] as const
  for (const stage of stages) await t.test(stage, async t => {
    const now = Date.now()
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now })
    const app = Fastify()
    t.after(() => app.close())
    const reads: string[] = []
    const nativeCalls: string[] = []
    let entered!: () => void, release!: () => void
    const enteredRead = new Promise<void>(resolve => { entered = resolve })
    const blockedRead = new Promise<void>(resolve => { release = resolve })
    let completed = false
    const read = async (name: string) => {
      reads.push(name)
      if (name === stage) { entered(); await blockedRead; completed = true }
    }
    registerAutomationPluginRoute(app, {
      authManager: { isLoopbackRequest: () => true }, bridgeToken: "secret",
      nativeParent: { request: async (method: string) => { nativeCalls.push(method); return {} } },
      workspaceManager: {
        getSharedServiceClient: async () => {
          await read("service")
          return { session: { get: async () => { await read("session"); return { location: { directory: "/repo" } } } } }
        },
        list: () => [{ id: "owner" }],
        ownsLocation: async () => { await read("ownership"); return true },
      },
    } as never)
    const execute = (deadline: number) => app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
      headers: { "x-codenomad-automation-token": "secret" },
      payload: { mode: "browser-execute", sessionID: "owned", command: { action: "snapshot" }, target: "document", deadline } })
    const pending = execute(now + 1_000).then(response => response)
    try {
      await enteredRead
      t.mock.timers.tick(1_000)
      const response = await Promise.race([pending, new Promise<void>(resolve => setImmediate(resolve))])
      assert.ok(response, "the HTTP deadline must settle before the underlying read finishes")
      assert.equal(response.statusCode, 409)
      assert.equal(response.json().code, "preview-expired")
      assert.equal(completed, false)
    } finally {
      release()
      await pending
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(completed, true, "the shared read can finish after its observer expires")
    assert.deepEqual(reads, stages.slice(0, stages.indexOf(stage) + 1))
    assert.deepEqual(nativeCalls, [], "late ownership work cannot dispatch the command")
    reads.length = 0
    const expired = await execute(now - 1)
    assert.equal(expired.statusCode, 409)
    assert.equal(expired.json().code, "preview-expired")
    assert.deepEqual(reads, [])
  })
})

test("preview HTTP responses expire while exact lease cleanup is still pending", async t => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now })
  const app = Fastify()
  t.after(() => app.close())
  let ending!: () => void, release!: () => void
  const endStarted = new Promise<void>(resolve => { ending = resolve })
  const endPending = new Promise<void>(resolve => { release = resolve })
  const methods: string[] = []
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true }, bridgeToken: "secret",
    nativeParent: { request: async (method: string) => {
      methods.push(method)
      if (method === "browser.page.end") { ending(); await endPending }
      if (method === "browser.page.begin") return { generation: "document", url: "https://example.test", driver: "cdp", contractVersion: 1 }
      if (method === "browser.page.send") return { nodes: [] }
      return {}
    } },
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "/repo" } }) } }),
      list: () => [{ id: "owner" }], ownsLocation: async () => true,
    },
  } as never)
  const snapshot = (deadline: number) => app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
    headers: { "x-codenomad-automation-token": "secret" },
    payload: { mode: "browser-execute", sessionID: "owned", command: { action: "snapshot" }, target: "document", deadline } }).then(response => response)
  const first = snapshot(now + 300)
  let second: ReturnType<typeof snapshot> | undefined
  try {
    await endStarted
    second = snapshot(now + 125)
    await new Promise<void>(resolve => setImmediate(resolve))
    t.mock.timers.tick(300)
    for (const pending of [first, second]) {
      const response = await Promise.race([pending, new Promise<void>(resolve => setImmediate(resolve))])
      assert.ok(response, "HTTP must expire independently of lease cleanup")
      assert.equal(response.statusCode, 409)
      assert.equal(response.json().code, "preview-expired")
    }
  } finally {
    release()
    await Promise.all([first, second])
  }
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(methods, ["browser.page.begin", "browser.page.send", "browser.page.check", "browser.page.end"])
})

test("a pause at the native channel cannot extend or revive an HTTP preview deadline", async t => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now })
  const app = Fastify()
  const messages: Array<{ method: string; deadline: number; operationID?: string }> = []
  const parent = new NativeParent({ write: line => {
    const { id, method, deadline, params } = JSON.parse(String(line).slice(NATIVE_REQUEST_PREFIX.length))
    messages.push({ method, deadline, operationID: params.operationID })
    const result = method === "browser.probe" ? { available: true, target: "document" }
      : method === "browser.page.begin" ? { generation: "document", url: "https://example.test", driver: "cdp", contractVersion: 1 }
      : method === "browser.page.send" ? { nodes: [] } : { url: "https://example.test" }
    queueMicrotask(() => parent.handleLine(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify({ v: 1, id, ok: true, result })}`))
    return true
  } }, true, false)
  t.after(async () => { parent.close(); await app.close() })
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true }, bridgeToken: "secret", nativeParent: parent,
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "/repo" } }) } }),
      list: () => [{ id: "owner" }], ownsLocation: async () => true,
    },
  } as never)
  const request = parent.request.bind(parent)
  let pauseBefore = "", pause = 0
  let afterReply: ((method: string) => void) | undefined
  t.mock.method(parent, "request", (...args: Parameters<typeof parent.request>) => {
    if (args[0] === pauseBefore) t.mock.timers.tick(pause)
    const response = request(...args)
    return afterReply ? response.then(result => { afterReply?.(args[0]); return result }) : response
  })
  const inject = (payload: Record<string, unknown>, deadline: number) =>
    app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
      headers: { "x-codenomad-automation-token": "secret" }, payload: { ...payload, sessionID: "owned", deadline } })
  for (const [method, payload] of [
    ["browser.probe", { mode: "browser-probe" }],
    ["browser.execute", { mode: "browser-execute", command: { action: "open", url: "https://example.test" } }],
    ["browser.page.begin", { mode: "browser-execute", command: { action: "snapshot" }, target: "document" }],
  ] as const) {
    for (const gap of [500, 1_000]) await t.test(`${method}, paused ${gap} ms`, async () => {
      pauseBefore = method
      pause = gap
      messages.length = 0
      const deadline = Date.now() + 1_000
      const response = await inject(payload, deadline)
      if (gap < 1_000) {
        assert.equal(response.statusCode, 200, response.body)
        const work = messages.filter(message => message.method !== "browser.page.end")
        assert.equal(work[0]?.method, method)
        assert.ok(work.every(message => message.deadline === deadline), JSON.stringify(work))
      } else {
        assert.equal(response.statusCode, method === "browser.probe" ? 503 : 409)
        assert.deepEqual(messages, [], "no command or cleanup is sent for an expired operation")
      }
    })
  }
  pauseBefore = ""
  for (const [budget, label] of [[1_000, "HTTP deadline"], [90_000, "page deadline"]] as const) {
    await t.test(`snapshot publication waits for page.end within the ${label}`, async () => {
      messages.length = 0
      afterReply = method => {
        if (method === "browser.page.check") t.mock.timers.setTime(messages.at(-1)!.deadline - 1)
        if (method === "browser.page.end") t.mock.timers.tick(2)
      }
      const response = await inject({ mode: "browser-execute", command: { action: "snapshot" }, target: "document" }, Date.now() + budget)
      assert.deepEqual(messages.map(message => message.method), ["browser.page.begin", "browser.page.send", "browser.page.check", "browser.page.end"])
      assert.ok(messages[0].operationID && messages.every(message => message.operationID === messages[0].operationID))
      assert.equal(response.statusCode, 409, response.body)
      assert.match(response.json().error, /timed out/)
      assert.equal(response.json().result, undefined)
    })
  }
  await t.test("an expired browser.execute result cannot be published", async () => {
    messages.length = 0
    const deadline = Date.now() + 1_000
    afterReply = method => {
      if (method === "browser.execute") t.mock.timers.setTime(deadline + 1)
    }
    const response = await inject({ mode: "browser-execute", command: { action: "screenshot" }, target: "document" }, deadline)
    assert.deepEqual(messages.map(message => message.method), ["browser.execute"])
    assert.equal(response.statusCode, 409, response.body)
    assert.equal(response.json().code, "preview-expired")
    assert.equal(response.json().result, undefined)
  })
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
  assert.equal(browser.statusCode, 404)
  assert.equal(browser.json().code, "no-preview-host")
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
  const browser = await request({ mode: "browser-claim", sessionID: "owned" })
  assert.equal(browser.statusCode, 404, "the browser tools cannot pick an owner that opens no page")
  assert.match(browser.json().error, /Browser automation is unavailable/)
  assert.equal((await request({ mode: "browser-claim", sessionID: "foreign", purpose: "mission" })).statusCode, 404,
    "ownership is still required for dispatch")
  assert.equal((await request({ mode: "browser-probe", sessionID: "owned" })).statusCode, 404)
  assert.equal((await request({ mode: "developer-probe", sessionID: "owned" })).statusCode, 404)
  assert.deepEqual(nativeCalls, ["developer.status"], "preview probes do not query a backend without a native host")
  await app.close()
})
