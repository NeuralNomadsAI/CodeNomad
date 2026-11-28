import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { describe, it, mock } from "node:test"
import type { BrowserWindow, WebContents } from "electron"
import { DIAGNOSTICS, type DiagnosticRead } from "../../../server/src/automation/page/diagnostic-events"
import { BrowserController, handleNativeBrowserRequest } from "./browser-controller"

interface GuestOptions {
  id: number
  owner: WebContents
  loadURL?: (url: string) => Promise<void>
  sendCommand?: (method: string, params?: Record<string, unknown>, session?: string) => Promise<unknown>
  insertText?: (text: string) => Promise<void>
  sendInputEvent?: (event: Electron.InputEvent) => void
  loading?: boolean
  documentRoot?: () => number
  stop?: () => void
}

function createGuest(options: GuestOptions) {
  const events = new EventEmitter()
  let attached = false
  let url = "https://example.com/"
  let attachCount = 0
  let detachCount = 0
  const guest = Object.assign(events, {
    id: options.id, hostWebContents: options.owner,
    getType: () => "webview", isDestroyed: () => false,
    isLoading: () => options.loading ?? false, isLoadingMainFrame: () => options.loading ?? false,
    stop: options.stop ?? (() => undefined), reload: () => undefined, getURL: () => url,
    insertText: options.insertText ?? (async (text: string) => { await options.sendCommand?.("Input.insertText", { text }) }),
    sendInputEvent: options.sendInputEvent ?? (() => undefined),
    loadURL: async (nextUrl: string) => {
      events.emit("did-start-navigation", {}, nextUrl, false, true)
      await options.loadURL?.(nextUrl)
      url = nextUrl
      events.emit("did-navigate", {}, nextUrl)
      events.emit("did-finish-load")
    },
    debugger: Object.assign(new EventEmitter(), {
      isAttached: () => attached,
      attach: () => { attached = true; attachCount += 1 },
      detach: () => { attached = false; detachCount += 1; guest.debugger.emit("detach", {}, "test") },
      sendCommand: async (method: string, params?: Record<string, unknown>, session?: string) => {
        if (method === "DOM.getDocument") {
          assert.deepEqual(params, { depth: 1 })
          return { root: { children: [{ nodeType: 1, backendNodeId: options.documentRoot?.() ?? 42 }] } }
        }
        return options.sendCommand?.(method, params, session) ?? {}
      },
    }),
  }) as unknown as WebContents
  return { guest, events, setUrl: (value: string) => { url = value }, counts: () => ({ attachCount, detachCount }) }
}

function createHarness(send: (owner: WebContents, channel: string, payload: any) => void = () => {}, autoReady = true) {
  const receipts: unknown[] = []
  const makeOwner = (id: number): WebContents => {
    const owner = { id, isDestroyed: () => false, send: (channel: string, payload: unknown) => {
      if (channel === "browser-target:open-settled") receipts.push(payload)
      else if (channel === "browser-target:open" || channel === "browser-target:discover") {
        if (autoReady && channel === "browser-target:open") {
          const { sessionID, instanceId, requestID } = payload as Record<string, unknown>
          controller.changeOwnership(owner, { action: "ready", sessionId: sessionID, instanceId, requestID })
        }
        send(owner, channel, payload)
      }
    } } as WebContents
    return owner
  }
  const owner = makeOwner(1), other = makeOwner(2)
  const guests = new Map<number, WebContents>()
  let visible = true
  const window = Object.assign(new EventEmitter(), {
    webContents: owner, isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false,
  }) as unknown as BrowserWindow
  const controller = new BrowserController(() => [owner, other], {
    fromId: id => guests.get(id) ?? null, fromWebContents: () => window,
  })
  controller.observeOwner(window)
  const add = (guest: WebContents, registrationId: string, sessionId = "session", instanceId?: string) => {
    const host = guest.hostWebContents
    assert.ok(host)
    if (instanceId) controller.changeOwnership(host, { action: "request", sessionId, instanceId })
    guests.set(guest.id, guest)
    controller.observeGuest(host, guest)
    controller.register(host, { sessionId, registrationId, instanceId, guestWebContentsId: guest.id })
  }
  return {
    controller, owner, other, add, receipts,
    hide: (event = "hide") => { visible = false; window.emit(event) },
    show: () => { visible = true },
  }
}

// Existing lifecycle scenarios keep their raw-CDP fixture vocabulary; the
// production transport receives only the new closed semantic operations.
const page = (controller: BrowserController, method: string, params: any, deadline = Infinity) => {
  if (method !== "send" || !params.method) return handleNativeBrowserRequest(controller, `browser.page.${method}`, params, deadline)
  const {method: command, params: data = {}, ...identity} = params
  const operations: Record<string, unknown> = {
    "Accessibility.getFullAXTree": {op:"tree"}, "DOM.resolveNode": {op:"resolve",node:42},
    "DOM.scrollIntoViewIfNeeded": {op:"scroll-into-view",node:42}, "DOM.getContentQuads": {op:"geometry",node:42},
    "DOM.getNodeForLocation": {op:"hit-test",x:0,y:0}, "Page.getLayoutMetrics": {op:"viewport"},
    "Runtime.callFunctionOn": {op:"call",function:"focus",handle:"h",args:[]},
    "Runtime.evaluate": {op:"call",function:"input-acceptance",args:[]},
    "Runtime.releaseObjectGroup": {op:"release-handles"}, "Input.insertText": {op:"insert-text",text:data && typeof data === "object" && !Array.isArray(data) ? data.text ?? "" : null},
    "Input.dispatchMouseEvent": {op:data?.type === "mouseWheel" ? "wheel" : "pointer",event:data},
    "Input.dispatchKeyEvent": {op:"keyboard",event:data},
  }
  return handleNativeBrowserRequest(controller, `browser.page.${method}`, {...identity,operation:operations[command] ?? {op:command}}, deadline)
}

async function begin(controller: BrowserController, sessionID = "session", operationID: string = randomUUID()) {
  const result = await page(controller, "begin", { sessionID, operationID, target: (await controller.probe(sessionID)).target }) as { generation: string; url: string }
  return { sessionID, operationID, generation: result.generation }
}

describe("BrowserController private page channel", () => {
  it("maps key presses and their text/default effects to the exact native guest without a prior click", async () => {
    const h = createHarness(), events: Electron.InputEvent[] = [], methods: string[] = []
    const { guest } = createGuest({ id: 82, owner: h.owner, sendInputEvent: event => { events.push(event) },
      sendCommand: async method => { methods.push(method); return {} } })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    await page(h.controller, "send", { ...lease, method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "a", text: "a", modifiers: 8 } })
    await page(h.controller, "send", { ...lease, method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "a", modifiers: 0 } })
    assert.deepEqual(events, [{ type: "keyDown", keyCode: "a", modifiers: ["shift"] },
      { type: "char", keyCode: "a", modifiers: ["shift"] }, { type: "keyUp", keyCode: "a", modifiers: [] }])
    assert.equal(methods.includes("Input.dispatchKeyEvent"), false)
    h.hide()
    await assert.rejects(page(h.controller, "send", { ...lease, method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Enter" } }), /no longer current/)
    assert.equal(events.length, 3)
  })
  it("refuses unsupported ContextMenu instead of emitting an unknown native key", async () => {
    const h = createHarness(), events: Electron.InputEvent[] = []
    const { guest } = createGuest({ id: 83, owner: h.owner, sendInputEvent: event => { events.push(event) } })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    await assert.rejects(page(h.controller, "send", { ...lease, method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "ContextMenu" } }),
      /does not support ContextMenu; use Shift\+F10/)
    assert.deepEqual(events, [])
  })
  it("inserts text through Electron's guest API while retaining lease checks", async () => {
    const h = createHarness(), inserted: string[] = [], methods: string[] = []
    const { guest } = createGuest({ id: 81, owner: h.owner,
      insertText: async text => { inserted.push(text) }, sendCommand: async method => { methods.push(method); return {} } })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    await page(h.controller, "send", { ...lease, method: "Input.insertText", params: { text: "Pilot" } })
    assert.deepEqual(inserted, ["Pilot"])
    assert.equal(methods.includes("Input.insertText"), false)
    h.hide()
    await assert.rejects(page(h.controller, "send", { ...lease, method: "Input.insertText", params: { text: "No" } }), /no longer current/)
    assert.deepEqual(inserted, ["Pilot"])
  })
  it("keeps the witness armed between leases, and invalidates on external detach or navigation", async () => {
    const h = createHarness()
    const { guest, events, counts } = createGuest({ id: 1, owner: h.owner })
    h.add(guest, "one")
    const first = await begin(h.controller)
    await page(h.controller, "end", first)
    const second = await begin(h.controller)
    assert.equal(second.generation, first.generation)
    assert.deepEqual(counts(), { attachCount: 1, detachCount: 0 })
    guest.debugger.detach()
    await assert.rejects(page(h.controller, "check", second), /no longer current/)
    const third = await begin(h.controller)
    assert.notEqual(third.generation, second.generation)
    events.emit("did-start-navigation", {}, "https://example.com/new", false, true)
    await assert.rejects(page(h.controller, "send", { ...third, method: "Input.insertText", params: { text: "no" } }), /no longer current/)
    const fourth = await begin(h.controller)
    assert.notEqual(fourth.generation, third.generation)
    await page(h.controller, "end", fourth)
  })

  it("refuses duplicate operations and simultaneous leases, with exact session and generation fencing", async () => {
    const h = createHarness()
    const { guest } = createGuest({ id: 2, owner: h.owner })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    await assert.rejects(begin(h.controller, "session", lease.operationID), /already exists/)
    await assert.rejects(begin(h.controller), /busy/)
    for (const input of [{ ...lease, sessionID: "foreign" }, { ...lease, generation: "stale" }]) {
      await assert.rejects(page(h.controller, "check", input), /no longer current/)
      await assert.rejects(page(h.controller, "send", { ...input, method: "Input.insertText" }), /no longer current/)
    }
    await page(h.controller, "end", { ...lease, sessionID: "foreign" })
    assert.deepEqual(await page(h.controller, "check", lease), { url: "https://example.com/" })
    await page(h.controller, "end", { sessionID: lease.sessionID, operationID: lease.operationID })
    await page(h.controller, "end", lease)
    await assert.rejects(page(h.controller, "check", lease), /no longer current/)
  })

  it("intercepts native file pickers from a page lease's start to its end", async () => {
    const h = createHarness()
    const intercepts: unknown[] = []
    const { guest } = createGuest({ id: 4, owner: h.owner, sendCommand: async (method, params) => {
      if (method === "Page.setInterceptFileChooserDialog") intercepts.push(params)
      return {}
    } })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    assert.deepEqual(intercepts, [{ enabled: true, cancel: true }])
    await page(h.controller, "end", lease)
    assert.deepEqual(intercepts, [{ enabled: true, cancel: true }, { enabled: false }])
  })

  it("probes only previews in the verified project tabs", async () => {
    const h = createHarness()
    const { guest } = createGuest({ id: 7, owner: h.owner })
    h.add(guest, "one", "session", "ws-a")
    await assert.rejects(handleNativeBrowserRequest(h.controller, "browser.probe", { sessionID: "session", workspaceIDs: ["ws-b"] }),
      /No visible|no longer|not shown|available/i, "another project tab's preview is no target")
    const probed = await handleNativeBrowserRequest(h.controller, "browser.probe", { sessionID: "session", workspaceIDs: ["ws-a"] }) as { available: boolean }
    assert.equal(probed.available, true)
    await assert.rejects(handleNativeBrowserRequest(h.controller, "browser.probe", { sessionID: "session", workspaceIDs: [""] }), /Invalid browser request/)
  })

  it("keeps a watched preview's console and network events per document and serves them to page leases", async () => {
    const h = createHarness()
    const sent: Array<[string, unknown, string?]> = []
    const { guest } = createGuest({ id: 5, owner: h.owner, sendCommand: async (method, params, session) => {
      sent.push(session ? [method, params, session] : [method, params])
      return method === "Network.getResponseBody" ? { body: "ok", base64Encoded: false } : {}
    } })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    assert.deepEqual(sent.filter(([method]) => DIAGNOSTICS.enable.some(([enable]) => enable === method)), DIAGNOSTICS.enable)
    guest.debugger.emit("message", {}, "Runtime.consoleAPICalled", { type: "log" })
    guest.debugger.emit("message", {}, "Network.requestWillBeSent", { requestId: "r1" }, "child-session")
    guest.debugger.emit("message", {}, "Page.frameNavigated", {})
    const first = await page(h.controller, "send", { ...lease, operation: { op: "diagnostics", after: 0 } }) as DiagnosticRead
    assert.deepEqual(first.events, [{ method: "Runtime.consoleAPICalled", params: { type: "log" } },
      { method: "Network.requestWillBeSent", params: { requestId: "r1" }, session: "child-session" }], "listed events, an out-of-process frame's with its session")
    assert.deepEqual(await page(h.controller, "send", { ...lease, operation: { op: "response-body", request: "r1", session: "child-session" } }), { body: "ok", base64Encoded: false })
    assert.deepEqual(sent.at(-1), ["Network.getResponseBody", { requestId: "r1" }, "child-session"])
    guest.debugger.emit("message", {}, "Target.attachedToTarget", { sessionId: "frame-1", targetInfo: { type: "iframe", url: "https://other.test/" } })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(sent.filter(call => call[2] === "frame-1").map(call => call[0]), [...DIAGNOSTICS.enable.map(([method]) => method), "Runtime.runIfWaitingForDebugger"], "a frame gets the same domains, then runs")
    guest.debugger.emit("message", {}, "Target.attachedToTarget", { sessionId: "worker-1", targetInfo: { type: "worker", url: "https://site.test/w.js" } })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(sent.filter(call => call[2] === "worker-1").map(call => call[0]), ["Runtime.runIfWaitingForDebugger"], "a worker only runs")
    assert.deepEqual(sent.at(-1), ["Target.detachFromTarget", { sessionId: "worker-1" }], "and is left")
    await page(h.controller, "end", lease)
    guest.emit("did-start-navigation", {}, "https://example.com/", true, true)
    guest.emit("did-start-navigation", {}, "https://example.com/next", false, true)
    const next = await begin(h.controller)
    const second = await page(h.controller, "send", { ...next, operation: { op: "diagnostics", after: 0 } }) as DiagnosticRead
    assert.deepEqual(second.events, [], "a new document's events start with it")
    assert.notEqual(second.epoch, first.epoch)
  })

  it("arms a new guest's diagnostics before its first load, and restarts them when the document is opened again", async () => {
    const h = createHarness()
    const sent: string[] = []
    const { guest } = createGuest({ id: 6, owner: h.owner, sendCommand: async method => { sent.push(method); return {} } })
    h.controller.guestCreated(guest)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(sent, ["Page.enable", ...DIAGNOSTICS.enable.map(([method]) => method)],
      "Page events and the diagnostic domains are enabled at creation, so a document.open() before any probe restarts them")
    guest.debugger.emit("message", {}, "Network.requestWillBeSent", { requestId: "first" })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    const first = await page(h.controller, "send", { ...lease, operation: { op: "diagnostics", after: 0 } }) as DiagnosticRead
    assert.deepEqual(first.events.map(event => event.params.requestId), ["first"], "the first page's own request is kept")
    await page(h.controller, "end", lease)
    guest.debugger.emit("message", {}, "Page.documentOpened", { frame: { id: "main" } })
    const next = await begin(h.controller)
    const reopened = await page(h.controller, "send", { ...next, operation: { op: "diagnostics", after: 0 } }) as DiagnosticRead
    assert.deepEqual(reopened.events, [])
    assert.notEqual(reopened.epoch, first.epoch, "document.open() starts a new document's diagnostics")
  })
  it("resumes paused child targets even when the preview's diagnostics are unavailable", async () => {
    const h = createHarness()
    const sent: Array<[string, string | undefined]> = []
    const { guest } = createGuest({ id: 8, owner: h.owner, sendCommand: async (method, _params, session) => {
      sent.push([method, session])
      if (method === "Log.enable" && !session) throw new Error("Log domain unavailable")
      return {}
    } })
    h.controller.guestCreated(guest)
    await new Promise(resolve => setImmediate(resolve))
    guest.debugger.emit("message", {}, "Target.attachedToTarget", { sessionId: "frame-9", targetInfo: { type: "iframe", url: "https://other.test/" } })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(sent.filter(([, session]) => session === "frame-9").map(([method]) => method), ["Runtime.runIfWaitingForDebugger"],
      "a frame of a preview without diagnostics runs at once")
  })
  it("accepts only the fixed protocol commands and bounded object params/responses", async () => {
    const h = createHarness()
    const calls: string[] = []
    const { guest } = createGuest({ id: 3, owner: h.owner, sendCommand: async method => {
      calls.push(method)
      return method === "Runtime.evaluate" ? { value: "x".repeat(4 * 1024 * 1024) } : { ok: true }
    } })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    for (const method of ["Page.navigate", "Page.enable", "Browser.close", "Network.enable", "DOM.getBoxModel", "Accessibility.enable"]) {
      await assert.rejects(page(h.controller, "send", { ...lease, method }), /Unsupported/)
    }
    for (const params of [null, [], "bad", { text: "x".repeat(256 * 1024) }]) {
      await assert.rejects(page(h.controller, "send", { ...lease, method: "Input.insertText", params }), /parameters/)
    }
    // A page lease intercepts native file pickers for its length.
    assert.deepEqual(calls, ["Page.enable", ...DIAGNOSTICS.enable.map(([method]) => method), "Page.setInterceptFileChooserDialog"])
    const valid = [
      [{op:"tree"},{nodes:[]}], [{op:"resolve",node:42},{}], [{op:"scroll-into-view",node:42},{ok:true}],
      [{op:"geometry",node:42},{ok:true}], [{op:"hit-test",x:0,y:0},{}], [{op:"viewport"},{}],
      [{op:"call",function:"focus",handle:"h",args:[]},{}], [{op:"release-handles"},{ok:true}],
      [{op:"insert-text",text:""},{}], [{op:"pointer",event:{type:"mouseMoved",x:1,y:1}},{ok:true}],
    ]
    for (const [operation,expected] of valid) assert.deepEqual(await page(h.controller,"send",{...lease,operation}),expected)
    assert.deepEqual(await page(h.controller, "send", { ...lease, method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "a" } }), {})
    await assert.rejects(page(h.controller, "send", { ...lease, method: "Runtime.evaluate" }), /response is too large/)
    assert.equal(guest.debugger.isAttached(), true)
    await assert.rejects(h.controller.execute("session", { action: "snapshot" } as never), /Invalid browser command/)
  })

  it("rejects a late reply and queued input when navigation changes the document", async () => {
    const h = createHarness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let inputs = 0
    const { guest, events } = createGuest({ id: 4, owner: h.owner, sendCommand: async method => {
      if (method === "Accessibility.getFullAXTree") { entered(); await gate }
      if (method === "Input.insertText") inputs++
      return {}
    } })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    const tree = page(h.controller, "send", { ...lease, method: "Accessibility.getFullAXTree" })
    await started
    const queued = page(h.controller, "send", { ...lease, method: "Input.insertText", params: { text: "no" } })
    events.emit("did-frame-navigate", {}, "https://example.com/", 200, "OK", true)
    release()
    await assert.rejects(tree, /no longer current/)
    await assert.rejects(queued, /no longer current/)
    assert.equal(inputs, 0)
  })

  it("serializes sends on one attachment and refuses an input result that navigated", async () => {
    const h = createHarness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const methods: string[] = []
    const { guest, events, counts } = createGuest({ id: 40, owner: h.owner, sendCommand: async method => {
      methods.push(method)
      if (method === "Accessibility.getFullAXTree") { entered(); await gate }
      if (method === "Input.dispatchMouseEvent") events.emit("did-navigate")
      return {}
    } })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    const tree = page(h.controller, "send", { ...lease, method: "Accessibility.getFullAXTree" })
    await started
    const input = page(h.controller, "send", { ...lease, method: "Input.insertText" })
    await Promise.resolve()
    assert.equal(methods.includes("Input.insertText"), false)
    release()
    await Promise.all([tree, input])
    assert.deepEqual(counts(), { attachCount: 1, detachCount: 0 })
    await assert.rejects(page(h.controller, "send", { ...lease, operation: {op:"pointer",event:{type:"mouseMoved",x:1,y:1}} }), /no longer current/)
    assert.deepEqual(counts(), { attachCount: 1, detachCount: 0 })
  })

  it("refuses ambiguous, hidden, unregistered, replaced and disposed targets", async () => {
    for (const change of ["ambiguous", "hidden", "unregistered", "replaced", "disposed"] as const) {
      const h = createHarness()
      const { guest, events } = createGuest({ id: 5, owner: h.owner })
      h.add(guest, "one")
      const lease = await begin(h.controller)
      if (change === "ambiguous") h.add(createGuest({ id: 6, owner: h.owner }).guest, "two")
      if (change === "hidden") h.hide()
      if (change === "unregistered") h.controller.unregister(h.owner, "one")
      if (change === "replaced") h.controller.register(h.owner, { sessionId: "session", registrationId: "one", guestWebContentsId: 5 })
      if (change === "disposed") events.emit("destroyed")
      await assert.rejects(page(h.controller, "send", { ...lease, method: "Input.insertText" }))
      await page(h.controller, "end", { sessionID: lease.sessionID, operationID: lease.operationID })
      if (change !== "disposed") assert.equal(guest.debugger.isAttached(), change === "ambiguous", change)
    }
  })

  it("preserves persistent mobile emulation across failed begin and lease expiry", async () => {
    const h = createHarness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { guest, counts } = createGuest({ id: 7, owner: h.owner, sendCommand: async method => {
      if (method === "Browser.getVersion") return { product: "Chrome/140.0.0.0" }
      if (method === "Page.enable") await gate
      return {}
    } })
    h.add(guest, "mobile")
    await h.controller.emulate(h.owner, "mobile", "mobile")
    await assert.rejects(h.controller.probe("session", Date.now() + 20), /timed out/)
    assert.deepEqual(counts(), { attachCount: 1, detachCount: 0 })
    release()
    mock.timers.enable({ apis: ["Date", "setTimeout"] })
    try {
      const lease = await begin(h.controller)
      mock.timers.tick(30_001)
      await assert.rejects(page(h.controller, "check", lease), /no longer current/)
      assert.equal(guest.debugger.isAttached(), true)
    } finally { mock.timers.reset() }
    await h.controller.emulate(h.owner, "mobile", "none")
    assert.deepEqual(counts(), { attachCount: 1, detachCount: 1 })
  })

  it("hands temporary debugger ownership to emulation without clearing its overrides on end", async () => {
    const h = createHarness()
    const { guest } = createGuest({ id: 8, owner: h.owner, sendCommand: async method =>
      method === "Browser.getVersion" ? { product: "Chrome/140.0.0.0" } : {} })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    await h.controller.emulate(h.owner, "one", "mobile")
    await page(h.controller, "end", lease)
    assert.equal(guest.debugger.isAttached(), true)
    guest.debugger.detach()
    await h.controller.emulate(h.owner, "one", "mobile")
    assert.equal(guest.debugger.isAttached(), true)
    await h.controller.emulate(h.owner, "one", "none")
  })

  it("never publishes a witness if Page.enable fails and releases only the attachment it opened", async () => {
    const h = createHarness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const { guest, counts } = createGuest({ id: 9, owner: h.owner, sendCommand: async () => {
      entered(); await gate; throw new Error("enable failed")
    } })
    h.add(guest, "one")
    const pending = h.controller.probe("session")
    await started
    await assert.rejects(page(h.controller, "begin", { sessionID: "session", operationID: "invalid" }), /identity/)
    release()
    await assert.rejects(pending, /enable failed/)
    assert.deepEqual(counts(), { attachCount: 1, detachCount: 1 })
  })

  it("expires owned leases after 30 seconds and bounds reservations at 32", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 })
    try {
      const h = createHarness()
      const first = createGuest({ id: 10, owner: h.owner })
      h.add(first.guest, "one")
      const lease = await begin(h.controller)
      for (let i = 1; i < 32; i++) {
        h.add(createGuest({ id: i + 10, owner: h.owner }).guest, `r${i}`, `s${i}`)
        await begin(h.controller, `s${i}`)
      }
      h.add(createGuest({ id: 99, owner: h.owner }).guest, "overflow", "overflow")
      await assert.rejects(begin(h.controller, "overflow"), /Too many/)
      mock.timers.tick(30_001)
      await assert.rejects(page(h.controller, "check", lease), /no longer current/)
      await assert.rejects(page(h.controller, "check", lease), /no longer current/)
      const next = await begin(h.controller, "overflow")
      await page(h.controller, "end", next)
    } finally { mock.timers.reset() }
  })

  it("fences deadlines before commands and after stalled IO without blocking later leases", async () => {
    const h = createHarness()
    let stalled = true
    let input = 0
    const { guest, counts } = createGuest({ id: 50, owner: h.owner, sendCommand: async method => {
      if (method === "Accessibility.getFullAXTree" && stalled) return new Promise(() => {})
      if (method === "Input.insertText") input++
      return {}
    } })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    await assert.rejects(page(h.controller, "send", { ...lease, method: "Input.insertText" }, Date.now()), /expired/)
    assert.equal(input, 0)
    await assert.rejects(page(h.controller, "send", { ...lease, method: "Accessibility.getFullAXTree" }, Date.now() + 20), /timed out/)
    assert.deepEqual(counts(), { attachCount: 1, detachCount: 0 })
    stalled = false
    const next = await begin(h.controller)
    await page(h.controller, "send", { ...next, method: "Input.insertText", params: { text: "ok" } })
    assert.equal(input, 1)
    await page(h.controller, "end", next)
  })
})

describe("BrowserController preview lifecycle", () => {
  it("binds probes and all admissions to the live root even before the document-open event", async () => {
    for (const action of ["navigate", "screenshot", "begin"] as const) {
      const h = createHarness()
      let root = 42
      const navigate = mock.fn(async () => {})
      const capture = mock.fn(async () => ({ data: "png" }))
      const { guest } = createGuest({ id: 119, owner: h.owner, documentRoot: () => root, loadURL: navigate,
        sendCommand: async method => method === "Page.captureScreenshot" ? capture() : {} })
      h.add(guest, "one")
      const sessionID = "session"
      const { target } = await h.controller.probe(sessionID)
      root++
      const operationID = randomUUID()
      const admission = action === "begin" ? page(h.controller, "begin", { sessionID, operationID, target })
        : h.controller.execute(sessionID, action === "navigate" ? { action, url: `${guest.getURL()}#next` } : { action }, Infinity, target)
      await assert.rejects(admission, /Browser target is stale/, action)
      assert.equal(navigate.mock.callCount(), 0)
      assert.equal(capture.mock.callCount(), 0)

      const { target: refreshed } = await h.controller.probe(sessionID)
      assert.notEqual(refreshed, target)
      assert.equal((await h.controller.probe(sessionID)).target, refreshed)
      const lease = await page(h.controller, "begin", { sessionID, operationID, target: refreshed }) as { generation: string }
      assert.notEqual(lease.generation, target)
      await page(h.controller, "end", { sessionID, operationID })
    }
  })

  it("rechecks the live root before using a lease and after reading page content", async () => {
    for (const phase of ["check", "input", "tree", "screenshot"] as const) {
      const h = createHarness()
      let root = 42
      const send = mock.fn(async (method: string) => {
        if (method === "Accessibility.getFullAXTree" || method === "Page.captureScreenshot") root++
        return { data: "png" }
      })
      const { guest } = createGuest({ id: 120, owner: h.owner, documentRoot: () => root, sendCommand: send })
      h.add(guest, "one")
      const lease = await begin(h.controller)
      if (phase === "check" || phase === "input") root++
      if (phase === "screenshot") {
        await assert.rejects(h.controller.execute(lease.sessionID, { action: "screenshot" }, Infinity, lease.generation), /Browser target is stale/)
      } else {
        const result = phase === "check" ? page(h.controller, "check", lease) : page(h.controller, "send", {
          ...lease, method: phase === "input" ? "Input.insertText" : "Accessibility.getFullAXTree",
        })
        await assert.rejects(result, /Browser page lease is no longer current/)
      }
      assert.equal(send.mock.calls.some(call => call.arguments[0] === "Input.insertText"), false)
      await assert.rejects(page(h.controller, "check", lease), /Browser page lease is no longer current/)
    }
  })

  it("preserves the main preview witness and lease through in-page navigation in an iframe", async () => {
    const h = createHarness()
    const { guest, events } = createGuest({ id: 117, owner: h.owner })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    events.emit("did-navigate-in-page", {}, "https://example.com/frame#section", false, 1, 2)
    assert.equal((await h.controller.probe("session")).target, lease.generation)
    assert.deepEqual(await page(h.controller, "check", lease), { url: guest.getURL() })

    events.emit("did-navigate-in-page", {}, "https://example.com/#section", true, 1, 1)
    await assert.rejects(page(h.controller, "check", lease), /no longer current/)
    assert.notEqual((await h.controller.probe("session")).target, lease.generation)
  })

  it("refuses an old witness after the main document stream reopens at the same URL between leases", async () => {
    const h = createHarness()
    const calls: string[] = []
    const inputs: Electron.InputEvent[] = []
    const sessionID = "session"
    const { guest } = createGuest({ id: 118, owner: h.owner, sendInputEvent: event => { inputs.push(event) },
      sendCommand: async method => { calls.push(method); return { data: "new document" } },
    })
    h.add(guest, "one")
    const { target } = await h.controller.probe(sessionID)
    const lease = await begin(h.controller)
    await page(h.controller, "end", lease)
    const opened = (frame: object, cdpSession?: string) => guest.debugger.emit("message", {}, "Page.documentOpened", { frame }, cdpSession)
    opened({ id: "child", parentId: "main" })
    opened({ id: "other" }, "nested-target")
    assert.equal((await h.controller.probe(sessionID)).target, target)
    assert.equal(guest.debugger.isAttached(), true)
    opened({ id: "main", url: guest.getURL() })
    const operationID = randomUUID()
    await assert.rejects(async () => {
      const { generation } = await page(h.controller, "begin", { sessionID, operationID, target }) as { generation: string }
      await page(h.controller, "send", { sessionID, operationID, generation, operation: { op: "keyboard", event: { type: "keyDown", key: "Enter" } } })
    }, /Browser target is stale/)
    await assert.rejects(h.controller.execute(sessionID, { action: "screenshot" }, Infinity, target), /Browser target is stale/)
    // The first lease's file-picker interception, then its release; the stale lease reached nothing.
    assert.deepEqual(calls, ["Page.enable", ...DIAGNOSTICS.enable.map(([method]) => method), "Page.setInterceptFileChooserDialog", "Page.setInterceptFileChooserDialog"])
    assert.deepEqual(inputs, [])
    const { target: refreshed } = await h.controller.probe(sessionID)
    assert.notEqual(refreshed, target)
    assert.deepEqual(await h.controller.execute(sessionID, { action: "screenshot" }, Infinity, refreshed),
      { image: { mime: "image/png", data: "new document" }, url: guest.getURL() })
  })

  it("binds native execute and page begin to the probed registration and document", async () => {
    for (const change of ["none", "navigation", "replacement", "hidden", "hide-show", "minimize-show", "absent", "ambiguous"] as const) {
      const h = createHarness()
      const navigate = mock.fn(async () => {})
      const send = mock.fn(async (method: string) => method === "Page.captureScreenshot" ? { data: "png" } : {})
      const { guest, events } = createGuest({ id: 90, owner: h.owner, loadURL: navigate, sendCommand: send })
      h.add(guest, "one")
      const sessionID = "session"
      const { available, target: probed } = await handleNativeBrowserRequest(h.controller, "browser.probe", { sessionID }) as { available: boolean; target: string }
      const target = change === "absent" ? undefined : probed
      assert.equal(available, true)
      assert.equal(typeof probed, "string")
      assert.ok(probed.length > 0 && probed.length <= 128)
      if (change === "navigation") events.emit("did-navigate")
      if (change === "replacement") h.controller.register(h.owner, { sessionId: sessionID, registrationId: "one", guestWebContentsId: 90 })
      if (change === "hidden") h.hide()
      if (change === "hide-show" || change === "minimize-show") {
        h.hide(change === "hide-show" ? "hide" : "minimize")
        h.show()
        assert.notEqual((await h.controller.probe(sessionID)).target, probed)
      }
      if (change === "ambiguous") h.add(createGuest({ id: 91, owner: h.owner }).guest, "two")
      const operationID = randomUUID()
      const execute = (command: object) => handleNativeBrowserRequest(h.controller, "browser.execute", { sessionID, target, command })
      const pageBegin = () => page(h.controller, "begin", { sessionID, operationID, ...(target === undefined ? {} : { target }) })
      const screenshot = { action: "screenshot" }
      const navigation = { action: "navigate", url: "https://example.com/next" }
      if (change === "none") {
        const lease = await pageBegin() as { generation: string }
        await page(h.controller, "end", { sessionID, operationID, generation: lease.generation })
        assert.deepEqual(await execute(screenshot), { image: { mime: "image/png", data: "png" }, url: "https://example.com/" })
        assert.equal((await execute(navigation) as { url: string }).url, navigation.url)
      } else {
        const error = change === "ambiguous" ? /Multiple visible browser targets exist for this session/
          : change === "absent" ? /A current browser target is required/ : /Browser target is stale/
        await assert.rejects(pageBegin(), error)
        await assert.rejects(execute(screenshot), error)
        await assert.rejects(execute(navigation), error)
        assert.equal(navigate.mock.callCount(), 0, change)
        // Only the document watch and its diagnostics domains were set up.
        const watch = ["Page.enable", ...DIAGNOSTICS.enable.map(([method]) => method)]
        assert.ok(send.mock.calls.every(call => watch.includes(call.arguments[0] as string)), change)
      }
    }
  })

  it("revalidates queued work before native input and each native result against its target", async () => {
    for (const scenario of ["queued", "capture", "reopened", "navigate", "replacement", "hide-show"] as const) {
      const h = createHarness()
      let enter!: () => void
      let release!: () => void
      const ready = new Promise<void>(resolve => { enter = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      const hold = async () => { enter(); await gate }
      const navigate = mock.fn(async () => { if (scenario !== "queued" && scenario !== "capture") await hold() })
      const { guest, events } = createGuest({ id: 92, owner: h.owner, loadURL: navigate,
         sendCommand: async method => { if (method === "Page.captureScreenshot") await hold(); return { data: "png" } },
      })
      h.add(guest, "one")
      const sessionID = "session"
      const { target } = await handleNativeBrowserRequest(h.controller, "browser.probe", { sessionID }) as { target: string }
      const navigation = { action: "navigate", url: "https://example.com/next" } as const
      const first = h.controller.execute(sessionID, ["queued", "capture", "reopened"].includes(scenario) ? { action: "screenshot" } : navigation, Infinity, target)
      await ready
      const queued = scenario === "queued"
        ? handleNativeBrowserRequest(h.controller, "browser.execute", { sessionID, target, command: navigation })
        : undefined
      const begin = scenario === "queued" ? assert.rejects(
        page(h.controller, "begin", { sessionID, target, operationID: randomUUID() }), /Browser target is stale/,
      ) : undefined
      if (scenario === "replacement") h.controller.register(h.owner, { sessionId: sessionID, registrationId: "one", guestWebContentsId: 92 })
      else if (scenario === "hide-show") { h.hide(); h.show() }
      else if (scenario === "reopened") guest.debugger.emit("message", {}, "Page.documentOpened", { frame: { id: "main", url: guest.getURL() } })
      else events.emit("did-navigate")
      release()
      if (scenario === "navigate") assert.equal((await first as { url: string }).url, navigation.url)
      else await assert.rejects(first, /Browser target is stale/)
      if (queued) {
        await assert.rejects(queued, /Browser target is stale/)
        await begin
        assert.equal(navigate.mock.callCount(), 0)
      }
    }
  })

  it("reads only bounded public history and refuses foreign or unsafe traversal", async () => {
    const h = createHarness()
    const commands: Array<{ method: string; params?: Record<string, unknown> }> = []
    const { guest } = createGuest({ id: 98, owner: h.owner, sendCommand: async (method, params) => {
      commands.push({ method, params })
      return { currentIndex: 1, entries: [{ id: 1, url: "about:blank", pageState: "secret" },
        { id: 2, url: "https://example.com/", pageState: "secret" }, { id: 3, url: "https://user:secret@example.com/" }] }
    } })
    h.add(guest, "history")
    h.controller.unregister(h.owner, "history")
    await assert.rejects(h.controller.probe("session"), /No visible local browser target/)
    assert.deepEqual(await h.controller.history(h.owner, 98), { entries: [{ id: 2, url: "https://example.com/" }], index: 0 })
    await assert.rejects(h.controller.history({ id: 2, isDestroyed: () => false } as WebContents, 98), /does not belong/)
    for (const id of [3, 7]) await assert.rejects(h.controller.history(h.owner, 98, id), /Invalid browser history entry/)
    await h.controller.history(h.owner, 98, 2)
    assert.deepEqual(commands[commands.length - 1], { method: "Page.navigateToHistoryEntry", params: { entryId: 2 } })
  })

  it("cleans window registrations and leases without reading destroyed native getters", async () => {
    const h = createHarness()
    let destroyed = false
    const window = new EventEmitter()
    Object.defineProperty(window, "webContents", { get() {
      if (destroyed) throw new TypeError("Object has been destroyed")
      return h.owner
    } })
    h.controller.observeOwner(window as unknown as BrowserWindow)
    const { guest } = createGuest({ id: 30, owner: h.owner })
    h.add(guest, "closed-window")
    await begin(h.controller)
    destroyed = true
    assert.doesNotThrow(() => window.emit("closed"))
    assert.equal(guest.debugger.isAttached(), false)
    await assert.rejects(h.controller.probe("session"), /No visible local browser target/)
  })

  it("fences queued emulation after target replacement and refuses another owner", async () => {
    const h = createHarness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const { guest } = createGuest({ id: 95, owner: h.owner, sendCommand: async method => {
      if (method === "Accessibility.getFullAXTree") { entered(); await gate }
      return {}
    } })
    h.add(guest, "emulation")
    await assert.rejects(h.controller.emulate({ id: 2 } as WebContents, "emulation", "mobile"), /does not belong/)
    const lease = await begin(h.controller)
    const tree = page(h.controller, "send", { ...lease, method: "Accessibility.getFullAXTree" })
    await started
    const emulation = h.controller.emulate(h.owner, "emulation", "mobile")
    h.controller.unregister(h.owner, "emulation")
    release()
    await assert.rejects(tree)
    await assert.rejects(emulation, /target changed/)
  })

  it("discovers in native rank order, pins one tab, and never redispatches after release", async () => {
    const trace: unknown[] = []
    const h = createHarness((owner, channel, { requestID, instanceId }) => {
      trace.push([owner.id, channel, instanceId])
      if (channel === "browser-target:discover") {
        assert.equal(h.controller.claimOpen(h.other, requestID, { kind: "discover", instanceId: "wrong" }), false)
        assert.equal(h.controller.claimOpen(owner, requestID, { kind: "discover", instanceId: owner === h.owner ? null : "second" }), true)
      } else {
        assert.equal(h.controller.claimOpen(h.owner, requestID, { kind: "target", instanceId, registrationId: "absent" }), false)
        assert.equal(h.controller.claimOpen(owner, requestID, { kind: "target", instanceId: "wrong", registrationId: "absent" }), false)
        assert.equal(h.controller.releaseOpen(owner, requestID), true)
      }
    })
    await assert.rejects(h.controller.open("session", "https://example.com/next", Infinity, ["second"]), /changed/)
    assert.deepEqual(trace, [[1, "browser-target:discover", undefined], [2, "browser-target:discover", undefined], [2, "browser-target:open", "second"]])
  })

  it("ignores a discovery receipt if the backend retires before native dispatch", async () => {
    let backendCurrent = true
    const h = createHarness((owner, channel, { requestID }) => {
      assert.equal(channel, "browser-target:discover")
      assert.equal(h.controller.claimOpen(owner, requestID, { kind: "discover", instanceId: "tab" }), true)
      backendCurrent = false
    })
    await assert.rejects(h.controller.open("session", "https://example.com/", Infinity, ["tab"], () => {
      if (!backendCurrent) throw new Error("Backend changed")
    }), /changed/)
  })

  it("opens in the existing owner's window without discovery or creating another guest", async t => {
    const h = createHarness((owner, channel, { requestID, instanceId }) => {
      assert.equal(channel, "browser-target:open")
      assert.equal(owner, h.other)
      assert.equal(h.controller.claimOpen(owner, requestID, { kind: "target", instanceId, registrationId: "visible" }), true)
    })
    const visible = createGuest({ id: 22, owner: h.other })
    h.add(visible.guest, "visible", "session", "tab")
    const duplicate = h.controller.changeOwnership(h.owner, { action: "request", sessionId: "session", instanceId: "duplicate" })
    assert.deepEqual(duplicate?.owner, { instanceId: "tab", sameWindow: false })
    const load = t.mock.method(visible.guest, "loadURL", async (url: string) => {
      visible.events.emit("did-start-navigation", {}, url, false, true)
      visible.setUrl(url)
      visible.events.emit("did-navigate", {}, url)
      visible.events.emit("did-finish-load")
    })
    const url = "https://example.com/new"
    assert.equal((await h.controller.open("session", url, Infinity, ["tab"])).url, url)
    assert.equal(load.mock.callCount(), 1)
  })

  it("a renderer which cannot show the preview leaves the duplicate free to open it", async () => {
    const h = createHarness((owner, channel, { requestID }) => {
      if (channel === "browser-target:discover") {
        h.controller.claimOpen(owner, requestID, { kind: "discover", instanceId: "tab" })
      } else {
        h.controller.releaseOpen(owner, requestID)
      }
    }, false)
    await assert.rejects(h.controller.open("session", "https://example.com/", Infinity, ["tab", "duplicate"]), /changed/)
    const snapshot = h.controller.changeOwnership(h.owner, { action: "request", sessionId: "session", instanceId: "duplicate" })
    assert.equal(snapshot?.owner?.instanceId, "duplicate")
  })

  it("uses the most recently used session tab across windows when there is no owner", async () => {
    const h = createHarness((owner, channel, { requestID, instanceId }) => {
      assert.equal(channel, "browser-target:open")
      assert.equal(owner, h.other)
      assert.equal(instanceId, "older-window-tab")
      h.controller.releaseOpen(owner, requestID)
    })
    h.controller.changeOwnership(h.owner, { action: "used", sessionId: "session", instanceId: "focused-window-tab" })
    h.controller.changeOwnership(h.other, { action: "used", sessionId: "session", instanceId: "older-window-tab" })
    h.controller.changeOwnership(h.owner, { action: "used", sessionId: "session", instanceId: "closed-tab" })
    h.controller.changeOwnership(h.owner, { action: "release", instanceId: "closed-tab" })
    h.controller.changeOwnership(h.owner, { action: "used", sessionId: "session", instanceId: "ineligible-tab" })
    await assert.rejects(h.controller.open("session", "https://example.com/", Infinity, ["focused-window-tab", "older-window-tab"]), /changed/)
  })

  it("requires occurrence authority for open and invalidates the prior document witness on success", async () => {
    const url = "https://example.com/next"
    const h = createHarness((owner, channel, { requestID, instanceId }) => {
      if (channel === "browser-target:discover") {
        h.controller.claimOpen(owner, requestID, { kind: "discover", instanceId: "tab" })
        return
      }
      assert.equal(h.controller.claimOpen(owner, requestID, { kind: "target", instanceId, registrationId: "one" }), true)
    })
    const { guest, counts } = createGuest({ id: 24, owner: h.owner, sendCommand: async () => ({ data: "png" }) })
    h.add(guest, "one", "session", "tab")
    const execute = (params: object) => handleNativeBrowserRequest(h.controller, "browser.execute", { sessionID: "session", ...params })
    const { target } = await h.controller.probe("session")
    const command = { action: "open", url }
    await assert.rejects(execute({ command, target }), /Owning project tabs are unavailable/)
    assert.equal((await execute({ command, workspaceIDs: ["tab"] }) as { url: string }).url, url)
    await assert.rejects(execute({ command: { action: "screenshot" }, target }), /Browser target is stale/)
    const refreshed = await h.controller.probe("session")
    assert.notEqual(refreshed.target, target)
    assert.deepEqual(await execute({ command: { action: "screenshot" }, target: refreshed.target }), {
      image: { mime: "image/png", data: "png" }, url,
    })
    assert.deepEqual(counts(), { attachCount: 1, detachCount: 0 })
  })

  it("supports back, forward and reload through guarded history/reload CDP operations", async () => {
    const h = createHarness()
    const history = { currentIndex: 1, entries: [{ id: 10, url: "https://example.com/a" }, { id: 11, url: "https://example.com/b" }, { id: 12, url: "https://example.com/c" }] }
    const cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
    let current = "https://example.com/b"
    const { guest } = createGuest({
      id: 25,
      owner: h.owner,
      sendCommand: async (method, params) => {
        cdpCalls.push({ method, params })
        if (method === "Page.getNavigationHistory") return history
        if (method === "Page.navigateToHistoryEntry") {
          const entry = history.entries.find(item => item.id === params?.entryId)!
          history.currentIndex = history.entries.indexOf(entry)
          current = entry.url
          guest.getURL = () => current
          queueMicrotask(() => {
            guest.emit("did-start-navigation", {}, current, false, true)
            guest.emit("did-navigate", {}, current)
            guest.emit("did-finish-load")
          })
          return {}
        }
        if (method === "Page.reload") {
          queueMicrotask(() => {
            guest.emit("did-start-navigation", {}, current, false, true)
            guest.emit("did-navigate", {}, current)
            guest.emit("did-finish-load")
          })
          return {}
        }
        return {}
      },
    })
    guest.getURL = () => current
    h.add(guest, "one", "session", "tab")
    const run = async (action: "back" | "forward" | "reload") => {
      const { target } = await h.controller.probe("session")
      return handleNativeBrowserRequest(h.controller, "browser.execute", { sessionID: "session", target, command: { action } })
    }
    assert.equal((await run("back") as { url: string }).url, "https://example.com/a")
    const { registration } = await h.controller.probe("session")
    assert.deepEqual(await run("forward"), { url: "https://example.com/b", registration }, "a load names the preview that made it")
    assert.deepEqual(await run("reload"), { url: "https://example.com/b", registration })
    assert.ok(cdpCalls.some(call => call.method === "Page.navigateToHistoryEntry" && call.params?.entryId === 10))
    assert.ok(cdpCalls.some(call => call.method === "Page.navigateToHistoryEntry" && call.params?.entryId === 11))
    assert.ok(cdpCalls.some(call => call.method === "Page.reload"))
  })

  for (const replace of [false, true]) {
    it(`navigates only the reported registration${replace ? " and refuses a replacement result" : ""}`, async () => {
      const url = "https://example.com/next"
      const trace: number[] = []
      let request = ""
      const h = createHarness((owner, channel, { requestID, instanceId }) => {
        assert.equal(owner, h.owner)
        if (channel === "browser-target:discover") {
          h.controller.claimOpen(owner, requestID, { kind: "discover", instanceId: "tab" })
          return
        }
        request = requestID
        assert.equal(h.controller.claimOpen(owner, requestID, { kind: "target", instanceId, registrationId: "other-tab", navigate: true }), false)
        assert.equal(h.controller.claimOpen(owner, requestID, { kind: "target", instanceId, registrationId: "exact", navigate: true }), true)
      })
      h.add(createGuest({ id: 15, owner: h.owner, loadURL: async () => { trace.push(15) } }).guest, "other-tab", "other-session", "sibling")
      const { guest } = createGuest({ id: 16, owner: h.owner, loadURL: async () => {
        trace.push(16)
        if (replace) h.controller.register(h.owner, { sessionId: "session", instanceId: "tab", registrationId: "exact", guestWebContentsId: 16 })
      } })
      h.add(guest, "exact", "session", "tab")
      const opening = h.controller.open("session", url, Infinity, ["tab"])
      if (replace) await assert.rejects(opening, /registration changed/)
      else assert.equal((await opening).url, url)
      assert.deepEqual(trace, [16])
      assert.deepEqual(h.receipts, [{ requestID: request, sessionID: "session", instanceId: "tab", committedUrl: replace ? undefined : url }])
    })
  }

  for (const scenario of ["post-commit fragment", "fragment-only", "replacement after commit", "fragment aborts initial load"] as const) {
    it(`keeps the exact navigation receipt: ${scenario}`, async t => {
      const fragmentOnly = scenario === "fragment-only"
      const replacement = scenario === "replacement after commit"
      const fragmentAborted = scenario === "fragment aborts initial load"
      const url = fragmentOnly ? "https://example.com/#requested" : "https://example.com/next"
      const committedUrl = fragmentOnly ? url : "https://example.com/redirected"
      const h = createHarness((owner, channel, { requestID, instanceId }) => {
        if (channel === "browser-target:discover") {
          h.controller.claimOpen(owner, requestID, { kind: "discover", instanceId: "tab" })
          return
        }
        assert.equal(h.controller.claimOpen(owner, requestID, { kind: "target", instanceId, registrationId: "one" }), true)
      })
      const { guest, events, setUrl } = createGuest({ id: 22, owner: h.owner })
      h.add(guest, "one", "session", "tab")
      t.mock.method(guest, "loadURL", async (requested: string) => {
        assert.equal(requested, url)
        events.emit("did-start-navigation", {}, requested, fragmentOnly, true)
        setUrl(committedUrl)
        if (fragmentOnly) {
          events.emit("did-navigate-in-page", {}, committedUrl, true)
          return
        }
        events.emit("did-navigate", {}, committedUrl)
        const next = replacement ? "https://example.com/replacement" : `${committedUrl}#after`
        events.emit("did-start-navigation", {}, next, !replacement, true)
        setUrl(next)
        if (replacement) events.emit("did-navigate", {}, next)
        else events.emit("did-navigate-in-page", {}, next, true)
        if (fragmentAborted) throw Object.assign(new Error("ERR_ABORTED (-3)"), { code: "ERR_ABORTED" })
        events.emit("did-finish-load")
      })
      const opening = h.controller.open("session", url, Infinity, ["tab"])
      if (replacement || fragmentAborted) await assert.rejects(opening, /Browser navigation changed/)
      else assert.equal((await opening).url, committedUrl)
      assert.deepEqual(h.receipts.map(receipt => (receipt as { committedUrl?: string }).committedUrl), [replacement || fragmentAborted ? undefined : committedUrl])
      if (replacement || fragmentAborted) {
        const receipt = h.receipts[0] as { keepGuest?: boolean; successorUrl?: string }
        assert.equal(receipt.keepGuest, true)
        assert.equal(receipt.successorUrl, replacement ? "https://example.com/replacement" : `${committedUrl}#after`)
      }
    })
  }

  it("waits for the main frame to finish when a child fragment resolves loadURL early", async t => {
    const h = createHarness()
    const { guest, events, setUrl } = createGuest({ id: 22, owner: h.owner })
    h.add(guest, "one")
    const url = "https://example.com/new"
    let childNavigated!: () => void
    const child = new Promise<void>(resolve => { childNavigated = resolve })
    t.mock.method(guest, "loadURL", async () => {
      events.emit("did-start-navigation", {}, url, false, true)
      setUrl(url)
      events.emit("did-navigate", {}, url)
      events.emit("did-navigate-in-page", {}, `${url}#child`, false)
      childNavigated()
    })
    let completed = false
    const target = (await h.controller.probe("session")).target
    // The deadline only bounds the test; parallel suites can delay these events beyond a second.
    const navigation = h.controller.execute("session", { action: "navigate", url }, Date.now() + 10_000, target)
      .then(result => { completed = true; return result })
    try {
      await child
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(completed, false)
    } finally {
      events.emit("did-finish-load")
      assert.equal((await navigation as { url: string }).url, url)
    }
  })

  it("reports the native failure from the exact first load", async () => {
    const h = createHarness((owner, channel, { requestID, instanceId }) => {
      if (channel === "browser-target:discover") {
        h.controller.claimOpen(owner, requestID, { kind: "discover", instanceId: "tab" })
        return
      }
      const { guest } = createGuest({ id: 22, owner, loadURL: async () => { throw new Error("connection refused (-102)") } })
      h.add(guest, "one", "session", "tab")
      assert.equal(h.controller.claimOpen(owner, requestID, { kind: "target", instanceId, registrationId: "one" }), true)
    })
    await assert.rejects(h.controller.open("session", "http://127.0.0.1:43127", Infinity, ["tab"]), /connection refused \(-102\)/)
    assert.equal(h.receipts.length, 1)
    assert.equal((h.receipts[0] as { committedUrl?: string }).committedUrl, undefined)
  })

  it("expires a queued open before an occupied native slot is released", async () => {
    let unblock!: () => void
    let occupied!: () => void
    const gate = new Promise<void>(resolve => { unblock = resolve })
    const started = new Promise<void>(resolve => { occupied = resolve })
    let loads = 0
    const h = createHarness((owner, channel, { requestID, instanceId }) => {
      if (channel === "browser-target:discover") {
        h.controller.claimOpen(owner, requestID, { kind: "discover", instanceId: "tab" })
        return
      }
      h.controller.claimOpen(owner, requestID, { kind: "target", instanceId, registrationId: "one" })
    })
    h.add(createGuest({ id: 22, owner: h.owner, loadURL: async () => { loads++ },
      sendCommand: async method => {
        if (method === "Browser.getVersion") return { product: "Chrome/123.0.0.0" }
        if (method === "Emulation.setDeviceMetricsOverride") { occupied(); await gate }
        return {}
       } }).guest, "one", "session", "tab")
    const emulation = h.controller.emulate(h.owner, "one", "mobile")
    let watchdog: NodeJS.Timeout | undefined
    try {
      await started
      const opening = h.controller.open("session", "https://example.com/queued", Date.now() + 80, ["tab"])
      await assert.rejects(Promise.race([opening, new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("Native slot still queued")), 500)
      })]), /timed out|expired/)
      assert.deepEqual(h.receipts.map(receipt => (receipt as { committedUrl?: string }).committedUrl), [undefined])
    } finally {
      clearTimeout(watchdog)
      unblock()
      await emulation
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(loads, 0)
  })

  it("retires a queued open when the acknowledged guest starts a user navigation", async () => {
    let unblock!: () => void, occupied!: () => void, acknowledged!: () => void
    const gate = new Promise<void>(resolve => { unblock = resolve })
    const started = new Promise<void>(resolve => { occupied = resolve })
    const ack = new Promise<void>(resolve => { acknowledged = resolve })
    const automated = "https://example.com/queued", manual = "https://example.com/manual"
    const loads: string[] = []
    const h = createHarness((owner, channel, { requestID, instanceId }) => {
      if (channel === "browser-target:discover") {
        h.controller.claimOpen(owner, requestID, { kind: "discover", instanceId: "tab" })
        return
      }
      assert.equal(h.controller.claimOpen(owner, requestID, { kind: "target", instanceId, registrationId: "one" }), true)
      acknowledged()
    })
    const { guest } = createGuest({ id: 22, owner: h.owner, loadURL: async url => { loads.push(url) },
      sendCommand: async method => {
        if (method === "Browser.getVersion") return { product: "Chrome/123.0.0.0" }
        if (method === "Emulation.setDeviceMetricsOverride") { occupied(); await gate }
        return {}
      } })
    h.add(guest, "one", "session", "tab")
    const emulation = h.controller.emulate(h.owner, "one", "mobile")
    await started
    const opening = h.controller.open("session", automated, Date.now() + 1000, ["tab"])
    const rejected = assert.rejects(opening, /changed/)
    await ack
    await new Promise<void>(resolve => setImmediate(resolve))
    await guest.loadURL(manual)
    const releasedWhileQueued = h.receipts.length
    try { await rejected } finally { unblock(); await emulation }
    assert.equal(releasedWhileQueued, 1)
    assert.equal(guest.getURL(), manual)
    assert.deepEqual(loads, [manual])
  })

  for (const scenario of ["timeout", "backend", "target", "superseded"]) {
    it(`cancels only the first open navigation: ${scenario}`, async () => {
      const url = "http://127.0.0.1:43127/"
      const next = "https://example.com/next"
      const stops: number[] = []
      let backendCurrent = true
      const h = createHarness((owner, channel, { requestID, instanceId }) => {
        if (channel === "browser-target:discover") {
          h.controller.claimOpen(owner, requestID, { kind: "discover", instanceId: "tab" })
          return
        }
        let complete!: () => void
        const { guest, events, setUrl } = createGuest({ id: 22, owner, loading: true, stop: () => stops.push(22),
          loadURL: () => new Promise<void>(resolve => { complete = resolve }) })
        h.add(guest, "first", "session", "tab")
        h.controller.claimOpen(owner, requestID, { kind: "target", instanceId, registrationId: "first" })
        setTimeout(() => {
          if (scenario === "backend") backendCurrent = false
          if (scenario === "target") {
            h.controller.unregister(owner, "first")
            h.add(createGuest({ id: 23, owner, stop: () => stops.push(23) }).guest, "first")
          }
          if (scenario === "superseded") {
            complete()
            events.emit("did-start-navigation", {}, next, false, true)
            setUrl(next)
          }
        }, 30)
      })
      await assert.rejects(h.controller.open("session", url, Date.now() + 150, ["tab"], () => {
        if (!backendCurrent) throw new Error("Backend changed")
      }),
        scenario === "timeout" ? /timed out|expired/ : /changed/)
      assert.deepEqual(stops, scenario === "superseded" ? [] : [22])
    })
  }

  it("permits at most one guest for the current owner and invalidates the witness on transfer", async () => {
    const h = createHarness()
    const { owner, other, controller } = h
    const first = controller.changeOwnership(owner, { action: "request", sessionId: "session", instanceId: "tab" })!
    const params = { webpreferences: `codenomadPreview=${first.revision}`, src: "about:blank" }
    assert.equal(controller.permitOpenAttachment(other, params), false)
    assert.equal(controller.permitOpenAttachment(owner, params), true)
    const { guest } = createGuest({ id: 22, owner })
    controller.guestCreated(guest)
    assert.equal(controller.permitOpenAttachment(owner, params), false)
    h.add(guest, "first", "session", "tab")
    const { target } = await controller.probe("session")
    const transfer = controller.changeOwnership(owner, { action: "request", sessionId: "session", instanceId: "duplicate", revision: first.revision })
    assert.equal(transfer?.owner?.instanceId, "duplicate")
    await assert.rejects(controller.execute("session", { action: "screenshot" }, Infinity, target), /stale/)
    assert.equal(controller.permitOpenAttachment(owner, params), false)
    h.add(guest, "new-registration", "session", "duplicate")
    assert.notEqual((await controller.probe("session")).target, target)
  })

  it("uses the remaining native budget after the exact guest is admitted", async t => {
    let now = Date.now()
    t.mock.method(Date, "now", () => now)
    const url = "https://example.com/slow"
    const h = createHarness((owner, channel, { requestID, instanceId }) => {
      if (channel === "browser-target:discover") {
        h.controller.claimOpen(owner, requestID, { kind: "discover", instanceId: "tab" })
        return
      }
      h.add(createGuest({ id: 22, owner, loadURL: async () => { now += 11_000 } }).guest, "first", "session", "tab")
      h.controller.claimOpen(owner, requestID, { kind: "target", instanceId, registrationId: "first" })
    })
    assert.equal((await h.controller.open("session", url, now + 90_000, ["tab"])).url, url)
  })

  it("propagates navigation failures and keeps the queue usable", async () => {
    const h = createHarness()
    const { guest } = createGuest({ id: 12, owner: h.owner, loadURL: async () => { throw new Error("connection refused") } })
    h.add(guest, "one")
    await assert.rejects(h.controller.execute("session", { action: "navigate", url: "https://example.com/fail" }, Infinity, (await h.controller.probe("session")).target), /connection refused/)
    const lease = await begin(h.controller)
    assert.deepEqual(await page(h.controller, "check", lease), { url: "https://example.com/" })
    await page(h.controller, "end", lease)
  })
})
