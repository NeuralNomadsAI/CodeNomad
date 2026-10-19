import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { describe, it, mock } from "node:test"
import type { BrowserWindow, WebContents } from "electron"
import { BrowserController, handleNativeBrowserRequest } from "./browser-controller"

interface GuestOptions {
  id: number
  owner: WebContents
  loadURL?: (url: string) => Promise<void>
  sendCommand?: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  insertText?: (text: string) => Promise<void>
  sendInputEvent?: (event: Electron.InputEvent) => void
  loading?: boolean
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
    isLoading: () => options.loading ?? false,
    stop: () => undefined, reload: () => undefined, getURL: () => url,
    insertText: options.insertText ?? (async (text: string) => { await options.sendCommand?.("Input.insertText", { text }) }),
    sendInputEvent: options.sendInputEvent ?? (() => undefined),
    loadURL: async (nextUrl: string) => { await options.loadURL?.(nextUrl); url = nextUrl },
    debugger: Object.assign(new EventEmitter(), {
      isAttached: () => attached,
      attach: () => { attached = true; attachCount += 1 },
      detach: () => { attached = false; detachCount += 1; guest.debugger.emit("detach", {}, "test") },
      sendCommand: options.sendCommand ?? (async () => ({})),
    }),
  }) as unknown as WebContents
  return { guest, events, counts: () => ({ attachCount, detachCount }) }
}

function createHarness(requestOpen: (sessionID: string, url: string, requestID: string) => void = () => {}) {
  const owner = { id: 1, isDestroyed: () => false } as WebContents
  const guests = new Map<number, WebContents>()
  let visible = true
  const window = { isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false } as BrowserWindow
  const controller = new BrowserController(requestOpen, {
    fromId: id => guests.get(id) ?? null, fromWebContents: () => window,
  })
  const add = (guest: WebContents, registrationId: string, sessionId = "session") => {
    guests.set(guest.id, guest)
    controller.observeGuest(owner, guest)
    controller.register(owner, { sessionId, registrationId, guestWebContentsId: guest.id })
  }
  return { controller, owner, add, hide: () => { visible = false } }
}

const page = (controller: BrowserController, method: string, params: object, deadline = Infinity) =>
  handleNativeBrowserRequest(controller, `browser.page.${method}`, params, deadline)

async function begin(controller: BrowserController, sessionID = "session", operationID: string = randomUUID()) {
  const result = await page(controller, "begin", { sessionID, operationID }) as { generation: string; url: string }
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
    await assert.rejects(page(h.controller, "send", { ...lease, method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Enter" } }), /visible/)
    assert.equal(events.length, 3)
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
    await assert.rejects(page(h.controller, "send", { ...lease, method: "Input.insertText", params: { text: "No" } }), /visible/)
    assert.deepEqual(inserted, ["Pilot"])
  })
  it("keeps generation stable across owned attach/end, and invalidates on external detach or navigation", async () => {
    const h = createHarness()
    const { guest, events, counts } = createGuest({ id: 1, owner: h.owner })
    h.add(guest, "one")
    const first = await begin(h.controller)
    await page(h.controller, "end", first)
    const second = await begin(h.controller)
    assert.equal(second.generation, first.generation)
    assert.deepEqual(counts(), { attachCount: 2, detachCount: 1 })
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

  it("accepts only the fixed protocol commands and bounded object params/responses", async () => {
    const h = createHarness()
    const calls: string[] = []
    const { guest } = createGuest({ id: 3, owner: h.owner, sendCommand: async method => {
      calls.push(method)
      return method === "Runtime.evaluate" ? { value: "x".repeat(4 * 1024 * 1024) } : { ok: true }
    } })
    h.add(guest, "one")
    const lease = await begin(h.controller)
    for (const method of ["Page.navigate", "Browser.close", "Network.enable", "DOM.getBoxModel", "Accessibility.enable"]) {
      await assert.rejects(page(h.controller, "send", { ...lease, method }), /Unsupported/)
    }
    for (const params of [null, [], "bad", { text: "x".repeat(256 * 1024) }]) {
      await assert.rejects(page(h.controller, "send", { ...lease, method: "Input.insertText", params }), /parameters/)
    }
    assert.deepEqual(calls, ["Accessibility.enable"])
    for (const method of ["Accessibility.getFullAXTree", "DOM.resolveNode", "DOM.scrollIntoViewIfNeeded", "DOM.getContentQuads",
      "DOM.getNodeForLocation", "Page.getLayoutMetrics", "Runtime.callFunctionOn", "Runtime.releaseObjectGroup",
      "Input.insertText", "Input.dispatchMouseEvent"]) {
      assert.deepEqual(await page(h.controller, "send", { ...lease, method, params: {} }), { ok: true })
    }
    assert.deepEqual(await page(h.controller, "send", { ...lease, method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "a" } }), {})
    await assert.rejects(page(h.controller, "send", { ...lease, method: "Runtime.evaluate" }), /response is too large/)
    assert.equal(guest.debugger.isAttached(), false)
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
    events.emit("did-frame-navigate")
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
    await assert.rejects(page(h.controller, "send", { ...lease, method: "Input.dispatchMouseEvent" }), /no longer current/)
    assert.deepEqual(counts(), { attachCount: 1, detachCount: 1 })
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
      assert.equal(guest.debugger.isAttached(), false)
    }
  })

  it("preserves persistent mobile emulation across failed begin and lease expiry", async () => {
    const h = createHarness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let stall = true
    const { guest, counts } = createGuest({ id: 7, owner: h.owner, sendCommand: async method => {
      if (method === "Browser.getVersion") return { product: "Chrome/140.0.0.0" }
      if (method === "Accessibility.enable" && stall) await gate
      return {}
    } })
    h.add(guest, "mobile")
    await h.controller.emulate(h.owner, "mobile", "mobile")
    await assert.rejects(page(h.controller, "begin", { sessionID: "session", operationID: randomUUID() }, Date.now() + 20), /timed out/)
    assert.deepEqual(counts(), { attachCount: 1, detachCount: 0 })
    release(); stall = false
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

  it("reserves during begin IO, refuses invalid IDs, and releases a failed owned attachment", async () => {
    const h = createHarness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const { guest, counts } = createGuest({ id: 9, owner: h.owner, sendCommand: async () => {
      entered(); await gate; throw new Error("enable failed")
    } })
    h.add(guest, "one")
    await assert.rejects(begin(h.controller, "session", "invalid"), /identity/)
    const operationID = randomUUID()
    const pending = begin(h.controller, "session", operationID)
    await started
    await assert.rejects(begin(h.controller, "session", operationID), /already exists/)
    await assert.rejects(begin(h.controller), /busy/)
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
      assert.equal(first.guest.debugger.isAttached(), false)
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
    assert.deepEqual(counts(), { attachCount: 1, detachCount: 1 })
    stalled = false
    const next = await begin(h.controller)
    await page(h.controller, "send", { ...next, method: "Input.insertText", params: { text: "ok" } })
    assert.equal(input, 1)
    await page(h.controller, "end", next)
  })
})

describe("BrowserController preview lifecycle", () => {
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
    assert.throws(() => h.controller.probe("session"), /No visible local browser target/)
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
    assert.throws(() => h.controller.probe("session"), /No visible local browser target/)
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

  it("allows one open owner and redistributes an explicitly released claim", async () => {
    const requests: string[] = []
    let requestID = ""
    const h = createHarness((_sessionID, _url, id) => { requestID = id; requests.push(id) })
    const pending = h.controller.execute("session", { action: "open", url: "https://example.com/next" })
    const other = { id: 2, isDestroyed: () => false } as WebContents
    assert.equal(h.controller.claimOpen(h.owner, requestID), true)
    assert.equal(h.controller.claimOpen(other, requestID), false)
    assert.equal(h.controller.releaseOpen(h.owner, requestID), true)
    assert.deepEqual(requests, [requestID, requestID])
    assert.equal(h.controller.claimOpen(h.owner, requestID), false)
    assert.equal(h.controller.claimOpen(other, requestID), true)
    const { guest, events } = createGuest({ id: 14, owner: h.owner, loading: true })
    h.add(guest, "one")
    events.emit("did-start-navigation", {}, "https://example.com/next", false, true)
    events.emit("did-finish-load")
    await pending
    assert.equal(h.controller.claimOpen(other, requestID), false)
  })

  it("reports ambiguity while waiting for a renderer target", async () => {
    let h!: ReturnType<typeof createHarness>
    h = createHarness(() => {
      for (const id of [20, 21]) h.add(createGuest({ id, owner: h.owner }).guest, `r${id}`)
    })
    await assert.rejects(h.controller.execute("session", { action: "open", url: "https://example.com/" }), /Multiple visible/)
  })

  for (const scenario of ["live-failure", "early-failure", "early-other-load", "live-other-load"]) {
    it(`preserves initial load failure semantics: ${scenario}`, async () => {
      let h!: ReturnType<typeof createHarness>
      h = createHarness(() => {
        const { guest, events } = createGuest({ id: 22, owner: h.owner, loading: scenario !== "early-failure" })
        h.add(guest, "one")
        const fail = () => events.emit("did-fail-load", {}, -102, "connection refused", "http://127.0.0.1:43127/", true)
        if (scenario === "early-failure") fail()
        else {
          if (scenario === "early-other-load") events.emit("did-finish-load")
          if (scenario === "live-other-load") setTimeout(() => events.emit("did-finish-load"), 25)
          setTimeout(fail, 75)
        }
      })
      await assert.rejects(h.controller.execute("session", { action: "open", url: "http://127.0.0.1:43127" }), /connection refused \(-102\)/)
    })
  }

  it("propagates navigation failures and keeps the queue usable", async () => {
    const h = createHarness()
    const { guest } = createGuest({ id: 12, owner: h.owner, loadURL: async () => { throw new Error("connection refused") } })
    h.add(guest, "one")
    await assert.rejects(h.controller.execute("session", { action: "navigate", url: "https://example.com/fail" }), /connection refused/)
    const lease = await begin(h.controller)
    assert.deepEqual(await page(h.controller, "check", lease), { url: "https://example.com/" })
    await page(h.controller, "end", lease)
  })
})
