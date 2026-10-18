import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { DeveloperCdp } from "./developer-cdp"

interface Command {
  id: number
  method: string
  params?: Record<string, unknown>
}

const page = (id: string) => ({
  id,
  title: `Page ${id}`,
  type: "page",
  url: `http://app.test/${id}`,
  webSocketDebuggerUrl: `ws://127.0.0.1:9222/${id}`,
})

class FakeSocket {
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  closed = false

  constructor(private readonly chrome: FakeChrome) {
    queueMicrotask(() => this.onopen?.({}))
  }

  send(data: string): void {
    this.chrome.receive(this, JSON.parse(data) as Command)
  }

  close(): void {
    this.closed = true
    this.onclose?.({})
  }

  respond(command: Command, result: Record<string, unknown> = {}): void {
    this.onmessage?.({ data: JSON.stringify({ id: command.id, result }) })
  }

  emit(method: string, params: Record<string, unknown> = {}): void {
    this.onmessage?.({ data: JSON.stringify({ method, params }) })
  }
}

class FakeChrome {
  target = page("one")
  targets: Array<ReturnType<typeof page>> | undefined
  context = { windowId: "window-1", instanceId: "workspace-1", sessionId: "session-1" }
  sockets: FakeSocket[] = []
  commands: Command[] = []
  deferred = new Map<string, { socket: FakeSocket; command: Command }>()
  screenshotData = Buffer.from("png").toString("base64")
  axNodes: Array<Record<string, unknown>> = [
    { backendDOMNodeId: 42, role: { value: "button" }, name: { value: "Save" } },
  ]

  fetch = async (input: string | URL | Request): Promise<Response> => {
    assert.equal(String(input), "http://127.0.0.1:9222/json/list")
    return new Response(JSON.stringify(this.targets ?? [this.target]))
  }

  connect = (_url: string): FakeSocket => {
    const socket = new FakeSocket(this)
    this.sockets.push(socket)
    return socket
  }

  receive(socket: FakeSocket, command: Command): void {
    this.commands.push(command)
    if (this.deferred.has(command.method)) {
      this.deferred.set(command.method, { socket, command })
      return
    }
    queueMicrotask(() => socket.respond(command, this.result(command.method)))
  }

  result(method: string): Record<string, unknown> {
    if (method === "Accessibility.getFullAXTree") return {
      nodes: this.axNodes,
    }
    if (method === "Runtime.evaluate") return { result: { value: this.context } }
    if (method === "Page.captureScreenshot") return { data: this.screenshotData }
    if (method === "DOM.resolveNode") return { object: { objectId: "node-1" } }
    return {}
  }

  client(overrides: Record<string, unknown> = {}): DeveloperCdp {
    return new DeveloperCdp({
      fetch: this.fetch as typeof globalThis.fetch,
      connect: this.connect,
      timeoutMs: 1_000,
      ...overrides,
    })
  }
}

const refOf = (inspection: { snapshot: string }) => /\[(e\d+)\]/.exec(inspection.snapshot)![1]

const identity = {
  endpoint: "http://127.0.0.1:9222",
  runId: "run-1",
  windowId: "window-1",
  sessionId: "session-1",
  instanceId: "workspace-1",
}

describe("DeveloperCdp", () => {
  it("keeps window-scoped tools usable across session/project navigation and empty views", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const window = { endpoint: identity.endpoint, runId: identity.runId, windowId: identity.windowId }
    try {
      const first = await client.inspect(window)
      chrome.context = { ...chrome.context, sessionId: "another-session", instanceId: "another-project" }
      await client.act({ ...window, kind: "click", ref: refOf(first) })
      assert.equal((await client.inspect(window)).context.sessionId, "another-session")
      chrome.context = { windowId: "window-1", sessionId: null, instanceId: null } as never
      assert.equal((await client.inspect(window)).context.sessionId, null)
      chrome.context = { ...chrome.context, windowId: "another-window" }
      await assert.rejects(client.screenshot(window), /window or active session changed/)
    } finally { client.close() }
  })

  it("matches out-of-order protocol responses and drains runtime diagnostics on inspect", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    await client.inspect(identity)
    const socket = chrome.sockets.at(-1)!
    for (let index = 0; index < 1_001; index++) {
      socket.emit("Runtime.consoleAPICalled", { type: "warning", args: [{ value: `message-${index}` }] })
    }
    socket.emit("Runtime.exceptionThrown", {
      exceptionDetails: { exception: { description: "Error: broken" } },
    })

    chrome.deferred.set("Accessibility.getFullAXTree", undefined as never)
    chrome.deferred.set("Page.captureScreenshot", undefined as never)
    const inspectionPromise = client.inspect(identity)
    while (!chrome.deferred.get("Accessibility.getFullAXTree")) await new Promise<void>((resolve) => setImmediate(resolve))
    const screenshotPromise = client.screenshot(identity)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(chrome.deferred.get("Page.captureScreenshot"), undefined)
    const inspectCommand = chrome.deferred.get("Accessibility.getFullAXTree")!
    inspectCommand.socket.respond(inspectCommand.command, chrome.result("Accessibility.getFullAXTree"))
    const inspection = await inspectionPromise
    while (!chrome.deferred.get("Page.captureScreenshot")) await new Promise<void>((resolve) => setImmediate(resolve))
    const screenshotCommand = chrome.deferred.get("Page.captureScreenshot")!
    screenshotCommand.socket.respond(screenshotCommand.command, { data: Buffer.from("shot").toString("base64") })
    const screenshot = await screenshotPromise
    assert.match(inspection.snapshot, /^- button "Save" \[e\d+\]$/)
    assert.equal(inspection.diagnostics.length, 1_000)
    assert.deepEqual(inspection.diagnostics[0], { level: "warning", text: "message-2" })
    assert.deepEqual(inspection.diagnostics.at(-1), { level: "error", text: "Error: broken" })
    assert.equal(Buffer.from(screenshot.data, "base64").toString(), "shot")

    chrome.deferred.clear()
    assert.deepEqual((await client.inspect(identity)).diagnostics, [])
    socket.emit("Runtime.consoleAPICalled", { type: "log", args: [{ value: "x".repeat(10_000) }] })
    assert.equal((await client.inspect(identity)).diagnostics[0].text.length, 512)
  })

  it("reconnects when the page target is replaced and rejects target-scoped refs", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const first = await client.inspect(identity)
    const oldRef = refOf(first)
    const oldSocket = chrome.sockets.at(-1)!

    chrome.target = page("two")
    const second = await client.inspect(identity)

    assert.equal(second.target.id, "two")
    assert.equal(oldSocket.closed, true)
    assert.equal(chrome.sockets.length, 4)
    await assert.rejects(client.act({ ...identity, kind: "click", ref: oldRef }), /stale ref/)
  })

  it("refreshes target metadata without reconnecting", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    await client.inspect(identity)
    chrome.target = { ...chrome.target, title: "Renamed", url: "http://app.test/current" }

    const inspection = await client.inspect(identity)

    assert.equal(inspection.target.title, "Renamed")
    assert.equal(inspection.target.url, "http://app.test/current")
    assert.equal(chrome.sockets.length, 2)
  })

  it("activates clicks through the resolved accessibility node", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const inspection = await client.inspect(identity)

    await client.act({ ...identity, kind: "click", ref: refOf(inspection) })

    assert.equal(chrome.commands.some((command) => command.method === "Input.dispatchMouseEvent"), false)
    assert.equal(chrome.commands.find((command) => command.method === "Runtime.callFunctionOn")?.params?.objectId, "node-1")
  })

  it("retries a failed WebSocket connection", async () => {
    const chrome = new FakeChrome()
    let attempts = 0
    const client = chrome.client({
      connect: (url: string) => {
        attempts += 1
        if (attempts > 1) return chrome.connect(url)
        const socket = {
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send() {},
          close() {},
        } as unknown as FakeSocket
        queueMicrotask(() => socket.onerror?.({}))
        return socket
      },
    })

    await assert.rejects(client.inspect(identity), /No CodeNomad page matches/)
    assert.equal((await client.inspect(identity)).target.id, "one")
    assert.equal(attempts, 3)
  })

  it("invalidates accessibility refs on frame navigation", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const inspection = await client.inspect(identity)
    chrome.sockets.at(-1)!.emit("Page.frameNavigated", { frame: { id: "main" } })

    await assert.rejects(
      client.act({ ...identity, kind: "type", ref: refOf(inspection), text: "hello", clear: true }),
      /stale ref/,
    )
  })

  it("invalidates refs when the target socket reconnects", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const inspection = await client.inspect(identity)
    chrome.sockets.at(-1)!.close()

    await assert.rejects(
      client.act({ ...identity, kind: "click", ref: refOf(inspection) }),
      /stale ref/,
    )
    assert.equal(chrome.sockets.length, 3)
  })

  it("rejects actions after the visible OpenCode session changes", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const inspection = await client.inspect(identity)
    chrome.context = { ...chrome.context, sessionId: "session-2" }

    await assert.rejects(
      client.act({ ...identity, kind: "click", ref: refOf(inspection) }),
      /active session changed/,
    )
    assert.equal(chrome.commands.some((command) => command.method === "Input.dispatchMouseEvent"), false)
  })

  it("invalidates refs and pending commands when an open socket errors", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const inspection = await client.inspect(identity)
    const oldRef = refOf(inspection)
    const socket = chrome.sockets.at(-1)!
    socket.onerror?.({})

    await assert.rejects(client.act({ ...identity, kind: "click", ref: oldRef }), /stale ref/)
    assert.equal(socket.closed, true)
  })

  it("rejects non-loopback WebSocket targets", async () => {
    const chrome = new FakeChrome()
    chrome.target = { ...chrome.target, webSocketDebuggerUrl: "ws://example.com/page" }
    await assert.rejects(chrome.client().inspect(identity), /No CodeNomad page matches/)
    assert.equal(chrome.sockets.length, 0)
  })

  it("aborts actions when navigation occurs between CDP commands", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const inspection = await client.inspect(identity)
    chrome.deferred.set("DOM.resolveNode", undefined as never)
    const action = client.act({ ...identity, kind: "click", ref: refOf(inspection) })
    while (!chrome.deferred.get("DOM.resolveNode")) await new Promise<void>((resolve) => setImmediate(resolve))
    const deferred = chrome.deferred.get("DOM.resolveNode")!
    deferred.socket.emit("Page.frameNavigated", { frame: { id: "main" } })
    deferred.socket.respond(deferred.command, chrome.result("DOM.resolveNode"))

    await assert.rejects(action, /Page changed during action/)
    assert.equal(chrome.commands.some((command) => command.method === "Input.dispatchMouseEvent"), false)
  })

  it("rejects captures and input when the visible instance changes mid-command", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const inspection = await client.inspect(identity)

    chrome.deferred.set("DOM.resolveNode", undefined as never)
    const action = client.act({ ...identity, kind: "click", ref: refOf(inspection) })
    while (!chrome.deferred.get("DOM.resolveNode")) await new Promise<void>((resolve) => setImmediate(resolve))
    chrome.context = { ...chrome.context, instanceId: "workspace-2" }
    const deferred = chrome.deferred.get("DOM.resolveNode")!
    deferred.socket.respond(deferred.command, chrome.result("DOM.resolveNode"))

    await assert.rejects(action, /Page changed during action/)
    assert.equal(chrome.commands.some((command) => command.method === "Input.dispatchMouseEvent"), false)
  })

  it("rejects screenshots over the configured PNG byte limit", async () => {
    const chrome = new FakeChrome()
    chrome.screenshotData = Buffer.from("12345").toString("base64")
    const client = chrome.client({ maxScreenshotBytes: 4 })
    await client.inspect(identity)

    await assert.rejects(client.screenshot(identity), /exceeds 4 byte limit/)
  })

  it("bounds accessibility snapshots and says what it collapsed", async () => {
    const chrome = new FakeChrome()
    chrome.axNodes = [{ nodeId: "root", backendDOMNodeId: 1, role: { value: "main" }, name: { value: "" },
      childIds: Array.from({ length: 4_000 }, (_, index) => `n${index}`) },
    ...Array.from({ length: 4_000 }, (_, index) => ({ nodeId: `n${index}`, parentId: "root", backendDOMNodeId: index + 2,
      role: { value: "button" }, name: { value: `Button ${index}` } }))]
    const inspection = await chrome.client().inspect(identity)
    assert.ok(inspection.snapshot.length <= 33_000, `${inspection.snapshot.length} characters`)
    assert.equal(inspection.collapsed, 1)
    assert.match(inspection.snapshot, /- \(\+\d+ more\)/)
    assert.match(inspection.snapshot, /"Button 0"[^\n]*\n/)
    assert.match(inspection.snapshot, /"Button 3999" \[e\d+\]$/, "the end of the page stays visible around the gap")
  })

  it("expands a ref's subtree and keeps refs stable across inspections of the same page", async () => {
    const chrome = new FakeChrome()
    chrome.axNodes = [
      { nodeId: "root", backendDOMNodeId: 1, role: { value: "main" }, childIds: ["toolbar", "dialog"] },
      { nodeId: "toolbar", parentId: "root", backendDOMNodeId: 2, role: { value: "toolbar" }, name: { value: "Actions" }, childIds: ["save"] },
      { nodeId: "save", parentId: "toolbar", backendDOMNodeId: 3, role: { value: "button" }, name: { value: "Save" } },
      { nodeId: "dialog", parentId: "root", backendDOMNodeId: 4, role: { value: "dialog" }, name: { value: "Rename" }, childIds: ["field"] },
      { nodeId: "field", parentId: "dialog", backendDOMNodeId: 5, role: { value: "textbox" }, name: { value: "Title" }, value: { value: "Old" } },
    ]
    const client = chrome.client()
    const full = await client.inspect(identity)
    const dialog = /dialog "Rename" \[(e\d+)\]/.exec(full.snapshot)![1]
    const save = /button "Save" \[(e\d+)\]/.exec(full.snapshot)![1]
    const scoped = await client.inspect(identity, { ref: dialog })
    assert.equal(scoped.snapshot, `- dialog "Rename" [${dialog}]\n  - textbox "Title" [${/textbox "Title" \[(e\d+)\]/.exec(full.snapshot)![1]}] value="Old"`)
    await client.act({ ...identity, kind: "click", ref: save })
    assert.match((await client.inspect(identity, { query: "save" })).snapshot, new RegExp(`button "Save" \\[${save}\\]`))
    assert.equal(/button "Save" \[(e\d+)\]/.exec((await client.inspect(identity)).snapshot)![1], save)
  })

  it("closes active target connections", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    await client.inspect(identity)
    client.close()
    assert.equal(chrome.sockets.at(-1)!.closed, true)
  })
})
