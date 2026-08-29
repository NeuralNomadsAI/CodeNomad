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
  webSocketDebuggerUrl: `ws://chrome.test/${id}`,
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
  sockets: FakeSocket[] = []
  commands: Command[] = []
  deferred = new Map<string, { socket: FakeSocket; command: Command }>()
  screenshotData = Buffer.from("png").toString("base64")
  axNodes: Array<Record<string, unknown>> = [
    { backendDOMNodeId: 42, role: { value: "button" }, name: { value: "Save" } },
  ]

  fetch = async (input: string | URL | Request): Promise<Response> => {
    assert.equal(String(input), "http://127.0.0.1:9222/json/list")
    return new Response(JSON.stringify([this.target]))
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
    if (method === "Page.captureScreenshot") return { data: this.screenshotData }
    if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } }
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

const identity = { endpoint: "http://127.0.0.1:9222", runId: "run-1", targetId: "one" }

describe("DeveloperCdp", () => {
  it("matches out-of-order protocol responses and drains runtime diagnostics on inspect", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    await client.inspect(identity)
    const socket = chrome.sockets[0]
    for (let index = 0; index < 1_001; index++) {
      socket.emit("Runtime.consoleAPICalled", { type: "warning", args: [{ value: `message-${index}` }] })
    }
    socket.emit("Runtime.exceptionThrown", {
      exceptionDetails: { exception: { description: "Error: broken" } },
    })

    chrome.deferred.set("Accessibility.getFullAXTree", undefined as never)
    chrome.deferred.set("Page.captureScreenshot", undefined as never)
    const inspectionPromise = client.inspect(identity)
    const screenshotPromise = client.screenshot(identity.runId)
    while ([...chrome.deferred.values()].some((value) => !value)) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    const screenshotCommand = chrome.deferred.get("Page.captureScreenshot")!
    const inspectCommand = chrome.deferred.get("Accessibility.getFullAXTree")!
    screenshotCommand.socket.respond(screenshotCommand.command, { data: Buffer.from("shot").toString("base64") })
    inspectCommand.socket.respond(inspectCommand.command, chrome.result("Accessibility.getFullAXTree"))

    const [inspection, screenshot] = await Promise.all([inspectionPromise, screenshotPromise])
    assert.equal(inspection.nodes[0].name, "Save")
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
    const oldRef = first.nodes[0].ref!
    const oldSocket = chrome.sockets[0]

    chrome.target = page("two")
    const second = await client.inspect({ ...identity, targetId: "two" })

    assert.equal(second.target.id, "two")
    assert.equal(oldSocket.closed, true)
    assert.equal(chrome.sockets.length, 2)
    await assert.rejects(client.act({ runId: identity.runId, kind: "click", ref: oldRef }), /stale accessibility ref/)
  })

  it("refreshes target metadata without reconnecting", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    await client.inspect(identity)
    chrome.target = { ...chrome.target, title: "Renamed", url: "http://app.test/current" }

    const inspection = await client.inspect(identity)

    assert.equal(inspection.target.title, "Renamed")
    assert.equal(inspection.target.url, "http://app.test/current")
    assert.equal(chrome.sockets.length, 1)
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

    await assert.rejects(client.inspect(identity), /connection failed/)
    assert.equal((await client.inspect(identity)).target.id, "one")
    assert.equal(attempts, 2)
  })

  it("invalidates accessibility refs on frame navigation", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const inspection = await client.inspect(identity)
    chrome.sockets[0].emit("Page.frameNavigated", { frame: { id: "main" } })

    await assert.rejects(
      client.act({ runId: identity.runId, kind: "type", ref: inspection.nodes[0].ref!, text: "hello" }),
      /stale accessibility ref/,
    )
  })

  it("invalidates refs when the target socket reconnects", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const inspection = await client.inspect(identity)
    chrome.sockets[0].close()

    await assert.rejects(
      client.act({ runId: identity.runId, kind: "click", ref: inspection.nodes[0].ref! }),
      /stale accessibility ref/,
    )
    assert.equal(chrome.sockets.length, 2)
  })

  it("aborts actions when navigation occurs between CDP commands", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const inspection = await client.inspect(identity)
    chrome.deferred.set("DOM.getBoxModel", undefined as never)
    const action = client.act({ runId: identity.runId, kind: "click", ref: inspection.nodes[0].ref! })
    while (!chrome.deferred.get("DOM.getBoxModel")) await new Promise<void>((resolve) => setImmediate(resolve))
    const deferred = chrome.deferred.get("DOM.getBoxModel")!
    deferred.socket.emit("Page.frameNavigated", { frame: { id: "main" } })
    deferred.socket.respond(deferred.command, chrome.result("DOM.getBoxModel"))

    await assert.rejects(action, /Page changed during action/)
    assert.equal(chrome.commands.some((command) => command.method === "Input.dispatchMouseEvent"), false)
  })

  it("rejects screenshots over the configured PNG byte limit", async () => {
    const chrome = new FakeChrome()
    chrome.screenshotData = Buffer.from("12345").toString("base64")
    const client = chrome.client({ maxScreenshotBytes: 4 })
    await client.inspect(identity)

    await assert.rejects(client.screenshot(identity.runId), /exceeds 4 byte limit/)
  })

  it("bounds accessibility snapshots", async () => {
    const chrome = new FakeChrome()
    chrome.axNodes = Array.from({ length: 800 }, (_, index) => ({
      backendDOMNodeId: index + 1,
      role: { value: "button" },
      name: { value: `Button ${index}` },
    }))
    const inspection = await chrome.client().inspect(identity)
    assert.equal(inspection.nodes.length, 750)
  })

  it("closes active target connections", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    await client.inspect(identity)
    client.close()
    assert.equal(chrome.sockets[0].closed, true)
  })
})
