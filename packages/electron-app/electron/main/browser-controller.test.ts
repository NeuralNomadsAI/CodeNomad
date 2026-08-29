import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { describe, it } from "node:test"
import type { BrowserWindow, WebContents } from "electron"
import { BrowserController } from "./browser-controller"

interface GuestOptions {
  id: number
  owner: WebContents
  loadURL?: (url: string) => Promise<void>
  sendCommand?: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  loading?: boolean
}

function createGuest(options: GuestOptions) {
  const events = new EventEmitter()
  let attached = false
  let url = "https://example.com/"
  let attachCount = 0
  let detachCount = 0
  const guest = Object.assign(events, {
    id: options.id,
    hostWebContents: options.owner,
    getType: () => "webview",
    isDestroyed: () => false,
    isLoading: () => options.loading ?? false,
    stop: () => undefined,
    getURL: () => url,
    loadURL: async (nextUrl: string) => {
      await options.loadURL?.(nextUrl)
      url = nextUrl
    },
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; attachCount += 1 },
      detach: () => { attached = false; detachCount += 1 },
      sendCommand: options.sendCommand ?? (async () => ({})),
    },
  }) as unknown as WebContents
  return { guest, events, counts: () => ({ attachCount, detachCount }) }
}

function createHarness(requestOpen: (sessionID: string, url: string, requestID: string) => void = () => {}) {
  const owner = { id: 1, isDestroyed: () => false } as WebContents
  const guests = new Map<number, WebContents>()
  const window = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false } as BrowserWindow
  const controller = new BrowserController(requestOpen, {
    fromId: (id) => guests.get(id) ?? null,
    fromWebContents: () => window,
  })
  const add = (guest: WebContents, registrationId: string, sessionId = "session") => {
    guests.set(guest.id, guest)
    controller.observeGuest(owner, guest)
    controller.register(owner, { sessionId, registrationId, guestWebContentsId: guest.id })
  }
  return { controller, owner, add }
}

describe("BrowserController", () => {
  it("serializes debugger commands for each guest", async () => {
    const harness = createHarness()
    let releaseTree!: () => void
    const treeGate = new Promise<void>((resolve) => { releaseTree = resolve })
    let treeCalls = 0
    const { guest, counts } = createGuest({
      id: 10,
      owner: harness.owner,
      sendCommand: async (method) => {
        if (method !== "Accessibility.getFullAXTree") return {}
        treeCalls += 1
        if (treeCalls === 1) await treeGate
        return { nodes: [] }
      },
    })
    harness.add(guest, "one")

    const first = harness.controller.execute("session", { action: "snapshot" })
    while (treeCalls === 0) await Promise.resolve()
    const second = harness.controller.execute("session", { action: "snapshot" })
    await Promise.resolve()
    assert.equal(treeCalls, 1)

    releaseTree()
    await Promise.all([first, second])
    assert.equal(treeCalls, 2)
    assert.deepEqual(counts(), { attachCount: 2, detachCount: 2 })
  })

  it("rejects queued commands after their session target unregisters", async () => {
    const harness = createHarness()
    let releaseTree!: () => void
    const treeGate = new Promise<void>((resolve) => { releaseTree = resolve })
    let treeCalls = 0
    const { guest } = createGuest({
      id: 13,
      owner: harness.owner,
      sendCommand: async (method) => {
        if (method !== "Accessibility.getFullAXTree") return {}
        treeCalls += 1
        if (treeCalls === 1) await treeGate
        return { nodes: [] }
      },
    })
    harness.add(guest, "one")

    const first = harness.controller.execute("session", { action: "snapshot" })
    while (treeCalls === 0) await Promise.resolve()
    const queued = harness.controller.execute("session", { action: "snapshot" })
    harness.controller.unregister(harness.owner, "one")
    releaseTree()

    await first
    await assert.rejects(queued, /No visible local browser target/)
    assert.equal(treeCalls, 1)
  })

  it("allows only one window to claim a missing-target open", async () => {
    let requestID = ""
    const harness = createHarness((_sessionID, _url, id) => { requestID = id })
    const pending = harness.controller.execute("session", { action: "open", url: "https://example.com/next" })
    assert.ok(requestID)
    assert.equal(harness.controller.claimOpen(harness.owner, requestID), true)
    const otherOwner = { id: 2, isDestroyed: () => false } as WebContents
    assert.equal(harness.controller.claimOpen(otherOwner, requestID), false)

    const { guest, events } = createGuest({ id: 14, owner: harness.owner, loading: true })
    harness.add(guest, "one")
    events.emit("did-start-navigation", {}, "https://example.com/next", false, true)
    events.emit("did-finish-load")
    await pending
    assert.equal(harness.controller.claimOpen(harness.owner, requestID), false)
  })

  it("does not publish snapshot refs when a frame navigates during capture", async () => {
    const harness = createHarness()
    let releaseTree!: () => void
    const treeGate = new Promise<void>((resolve) => { releaseTree = resolve })
    let treeStarted = false
    const { guest, events } = createGuest({
      id: 11,
      owner: harness.owner,
      sendCommand: async (method) => {
        if (method !== "Accessibility.getFullAXTree") return {}
        treeStarted = true
        await treeGate
        return { nodes: [{ backendDOMNodeId: 42, role: { value: "button" }, name: { value: "Save" } }] }
      },
    })
    harness.add(guest, "one")
    const snapshot = harness.controller.execute("session", { action: "snapshot" })
    while (!treeStarted) await Promise.resolve()

    events.emit("did-frame-navigate")
    releaseTree()
    await snapshot

    await assert.rejects(harness.controller.execute("session", { action: "click", ref: "e1" }), /take a new snapshot/)
  })

  it("reports ambiguity while waiting for a renderer target", async () => {
    let controller!: BrowserController
    const owner = { id: 1, isDestroyed: () => false } as WebContents
    const guests = new Map<number, WebContents>()
    const window = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false } as BrowserWindow
    controller = new BrowserController(() => {
      for (const id of [20, 21]) {
        const { guest } = createGuest({ id, owner })
        guests.set(id, guest)
        controller.observeGuest(owner, guest)
        controller.register(owner, { sessionId: "session", registrationId: `registration-${id}`, guestWebContentsId: id })
      }
    }, {
      fromId: (id) => guests.get(id) ?? null,
      fromWebContents: () => window,
    })

    await assert.rejects(
      controller.execute("session", { action: "open", url: "https://example.com/" }),
      /Multiple visible browser targets exist for this session/,
    )
  })

  it("propagates the initial renderer load failure after opening a missing target", async () => {
    let harness!: ReturnType<typeof createHarness>
    harness = createHarness(() => {
      const { guest, events } = createGuest({ id: 22, owner: harness.owner, loading: true })
      harness.add(guest, "one")
      setTimeout(() => events.emit("did-fail-load", {}, -102, "connection refused", "http://127.0.0.1:43127/", true), 75)
    })

    await assert.rejects(
      harness.controller.execute("session", { action: "open", url: "http://127.0.0.1:43127" }),
      /connection refused \(-102\)/,
    )
  })

  it("propagates an initial load failure that occurs before registration", async () => {
    let harness!: ReturnType<typeof createHarness>
    harness = createHarness(() => {
      const { guest, events } = createGuest({ id: 23, owner: harness.owner, loading: false })
      harness.add(guest, "one")
      events.emit("did-fail-load", {}, -102, "connection refused", "http://127.0.0.1:43128/", true)
    })

    await assert.rejects(
      harness.controller.execute("session", { action: "open", url: "http://127.0.0.1:43128" }),
      /connection refused \(-102\)/,
    )
  })

  it("does not satisfy open with a completed load for another URL", async () => {
    let harness!: ReturnType<typeof createHarness>
    harness = createHarness(() => {
      const { guest, events } = createGuest({ id: 24, owner: harness.owner, loading: true })
      harness.add(guest, "one")
      events.emit("did-finish-load")
      setTimeout(() => events.emit("did-fail-load", {}, -102, "connection refused", "http://127.0.0.1:43128/", true), 25)
    })

    await assert.rejects(
      harness.controller.execute("session", { action: "open", url: "http://127.0.0.1:43128" }),
      /connection refused \(-102\)/,
    )
  })

  it("ignores a live load completion for another URL", async () => {
    let harness!: ReturnType<typeof createHarness>
    harness = createHarness(() => {
      const { guest, events } = createGuest({ id: 25, owner: harness.owner, loading: true })
      harness.add(guest, "one")
      setTimeout(() => events.emit("did-finish-load"), 25)
      setTimeout(() => events.emit("did-fail-load", {}, -102, "connection refused", "http://127.0.0.1:43128/", true), 50)
    })

    await assert.rejects(
      harness.controller.execute("session", { action: "open", url: "http://127.0.0.1:43128" }),
      /connection refused \(-102\)/,
    )
  })

  it("propagates load failures and continues the guest queue", async () => {
    const harness = createHarness()
    const { guest } = createGuest({
      id: 12,
      owner: harness.owner,
      loadURL: async () => { throw new Error("connection refused") },
      sendCommand: async (method) => method === "Accessibility.getFullAXTree" ? { nodes: [] } : {},
    })
    harness.add(guest, "one")

    await assert.rejects(harness.controller.execute("session", { action: "navigate", url: "https://example.com/fail" }), /connection refused/)
    assert.deepEqual(await harness.controller.execute("session", { action: "snapshot" }), {
      url: "https://example.com/",
      snapshot: "No accessible elements found",
    })
  })

  it("expires stalled debugger work without blocking the guest queue", async () => {
    const harness = createHarness()
    let calls = 0
    const { guest } = createGuest({
      id: 26,
      owner: harness.owner,
      sendCommand: async (method) => {
        if (method !== "Accessibility.getFullAXTree") return {}
        calls += 1
        if (calls === 1) return new Promise(() => {})
        return { nodes: [] }
      },
    })
    harness.add(guest, "one")

    await assert.rejects(
      harness.controller.execute("session", { action: "snapshot" }, Date.now() + 20),
      /timed out/,
    )
    assert.deepEqual(await harness.controller.execute("session", { action: "snapshot" }), {
      url: "https://example.com/",
      snapshot: "No accessible elements found",
    })
  })
})
