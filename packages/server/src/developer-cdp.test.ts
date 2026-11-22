import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"
import { DeveloperCdp, StaleDeveloperDocument } from "./developer-cdp"
import { AUTOMATION_BRIDGE_PATH } from "./opencode/automation-plugin"
import { registerAutomationPluginRoute } from "./server/routes/automation-plugin"

interface Command {
  id: number
  method: string
  params?: Record<string, unknown>
}

const isDestination = (command: Command) => command.method === "Runtime.callFunctionOn"
  && String(command.params?.functionDeclaration).includes("document.elementFromPoint")
const isScriptClick = (command: Command) => command.method === "Runtime.callFunctionOn"
  && String(command.params?.functionDeclaration).startsWith("function (handle, expected, ...args)")
const isInputState = (command: Command) => command.method === "Runtime.evaluate"
  && command.params?.expression === "({ root: document.documentElement })"

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
  context = { windowId: "window-1", instanceId: "workspace-1", sessionId: "session-1", tabId: "tab-1", windowInstance: undefined as string | undefined }
  onCommand?: (command: Command) => void
  skipReply?: (command: Command) => boolean
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
    this.onCommand?.(command)
    this.commands.push(command)
    if (this.skipReply?.(command)) return
    if (this.deferred.has(command.method)) {
      this.deferred.set(command.method, { socket, command })
      return
    }
    queueMicrotask(() => socket.respond(command, isInputState(command)
      ? { result: { objectId: "input-document" } } : isScriptClick(command)
        ? this.scriptClick(command) : command.method === "Runtime.callFunctionOn"
        && command.params?.objectId === "input-document" ? {
          result: { value: !this.inputRootCurrent ? "root" : isDestination(command) ? this.destination(command)
            : String(command.params.functionDeclaration).includes("Math.min") ? true : 1_700_000_000 },
        } : command.method === "Runtime.callFunctionOn" && String(command.params?.functionDeclaration).includes("window.top") ? {
          result: { value: this.mainRef },
         } : command.params?.expression === "document.activeElement" ? this.activeElementReply
           : command.params?.objectId === "active-element" ? { result: { value: "button" } } : this.result(command.method)))
  }

  /** Visible box of every element, or none; and the element hit at its centre. */
  quads: number[][] = []
  hit = 42
  hitFrame = "main"
  hitTag = "button"
  mainFocus = true
  activeElementReply: Record<string, unknown> = { result: { objectId: "active-element" } }
  inputRootCurrent = true
  mainRef = true
  functionResult: unknown
  scriptClicks = 0
  receiver = 1
  pointerReceipt?: { id: number; receiver: number }

  private scriptClick(command: Command): Record<string, unknown> {
    const [handle, expected] = command.params!.arguments as [{ objectId: string }, { value: FakeChrome["context"] }]
    assert.equal(command.params!.objectId, "input-document")
    assert.equal(handle.objectId, "node-1")
    const refusal = !this.inputRootCurrent ? "action-root"
      : (["tabId", "instanceId", "sessionId"] as const).some(key => this.context[key] !== expected.value[key]) ? "action-tab" : null
    if (refusal) return { exceptionDetails: { text: `Error: codenomad:${refusal}` } }
    if (String(command.params!.functionDeclaration).includes("codenomad:has-box")) this.scriptClicks++
    return { result: { value: null } }
  }

  private destination(command: Command): string {
    const [point, expected, release, , , , track, confirm] = command.params!.arguments as [
      { value: { x: number; y: number } | null }, { value: FakeChrome["context"] }, { value: boolean },
      unknown, unknown, unknown, { value: number | null }, { value: number | null },
    ]
    if (!release.value && (["tabId", "instanceId", "sessionId"] as const).some(key => this.context[key] !== expected.value[key])) return "tab"
    if (!(point.value ? this.hitFrame === "main" && this.hitTag !== "iframe" : this.mainFocus)) return "frame"
    if (confirm.value && (this.pointerReceipt?.id !== confirm.value || this.pointerReceipt.receiver !== this.receiver)) return "receiver"
    if (track.value) this.pointerReceipt = { id: track.value, receiver: this.receiver }
    return "ready"
  }

  result(method: string): Record<string, unknown> {
    if (method === "Accessibility.getFullAXTree") return {
      nodes: this.axNodes,
    }
    if (method === "DOM.getContentQuads") return { quads: this.quads }
    if (method === "DOM.getNodeForLocation") return { backendNodeId: this.hit, frameId: this.hitFrame }
    if (method === "DOM.describeNode") return { node: { localName: this.hitTag } }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } }
    if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }
    if (method === "Runtime.evaluate") return { result: { value: this.context } }
    if (method === "Runtime.callFunctionOn") return { result: { value: this.functionResult } }
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
  it("can inspect a surviving window after an acknowledged restart is cancelled", async t => {
    const a = { runId: identity.runId, nativeIdentity: "electron:test", windowId: "window-A", windowInstance: "incarnation-A" }
    const b = { ...a, windowId: identity.windowId, windowInstance: "incarnation-B" }
    const first = new FakeChrome(), second = new FakeChrome()
    first.context = { ...first.context, windowId: a.windowId, windowInstance: a.windowInstance }
    second.context.windowInstance = b.windowInstance
    second.target = page("two")
    first.targets = [first.target, second.target]
    const developerCdp = first.client({ connect: (url: string) => url.endsWith("/two") ? second.connect(url) : first.connect(url) })
    const app = Fastify()
    t.after(async () => { developerCdp.close(); await app.close() })
    const command = { ...a, restartId: "8d80a777-0085-48c8-b791-d3514bd63f32" }
    let windows = [a, b], scheduled: (() => void) | undefined
    let restarts = 0, relaunched = false
    registerAutomationPluginRoute(app, {
      authManager: { isLoopbackRequest: () => true }, bridgeToken: "fixture", developerCdp,
      workspaceManager: {
        getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "/repo" } }) } }),
        list: () => [{ id: "owner" }], ownsLocation: async () => true,
      },
      nativeParent: { request: async (method: string, params: Partial<typeof a>) => {
        if (method === "developer.restartScope") {
          assert.deepEqual(params, command)
          restarts++
          scheduled = () => { relaunched = windows.includes(a) }
          return command
        }
        if (method === "developer.reconnect") throw new Error("No matching CodeNomad relaunch")
        assert.ok(method === "developer.status" || method === "developer.targets")
        const selected = params.windowId === undefined ? windows[0] : windows.find(window =>
          window.windowId === params.windowId && window.windowInstance === params.windowInstance && window.runId === params.runId)
        return { windows, status: selected ? { ...selected, state: "ready", cdpUrl: identity.endpoint } : { state: "starting" } }
      } },
    } as never)
    const request = (sessionID: string, payload: object) => app.inject({
      method: "POST", url: AUTOMATION_BRIDGE_PATH, headers: { "x-codenomad-automation-token": "fixture" },
      payload: { sessionID, ...payload },
    })
    const execute = (session: string, command: object, options: object = {}) =>
      request(session, { mode: "developer-execute", command, ...options })
    const inspect = (session: string, window: typeof a) => execute(session, { action: "inspect" }, {
      target: `${window.nativeIdentity}/${window.runId}/${window.windowId}/${window.windowInstance}`,
    })

    const previous = (await inspect("ses_B", b)).json().result
    const pinA = (await inspect("ses_A", a)).json().result.pin
    const restart = await request("ses_A", { mode: "developer-restart", command, pin: pinA })
    assert.equal(restart.statusCode, 200, restart.body)
    windows = [b]
    first.targets = [second.target]
    scheduled!()
    assert.equal(relaunched, false)

    assert.equal((await request("ses_A", { mode: "developer-reconnect", command })).statusCode, 404)
    assert.equal((await inspect("ses_A", a)).json().code, "target-gone")
    const inventory = await request("ses_A", { mode: "developer-probe", purpose: "targets" })
    assert.deepEqual(inventory.json().result.windows.map((window: typeof b) => window.windowId), [b.windowId])
    assert.equal((await execute("ses_A", { action: "inspect" })).statusCode, 409)
    assert.equal((await execute("ses_B", { action: "press", key: "Enter" }, { pin: previous.pin })).json().code, "target-gone")
    const recovered = await inspect("ses_B", b)
    assert.equal(recovered.statusCode, 200, recovered.body)
    const fresh = recovered.json().result
    assert.equal(fresh.context.windowInstance, b.windowInstance)
    assert.notEqual(refOf(fresh), refOf(previous))
    for (const command of [{ action: "screenshot" }, { action: "inspect" }, { action: "inspect", ref: refOf(previous) }]) {
      assert.equal((await execute("ses_B", command, { pin: previous.pin })).json().code, "target-gone")
    }
    assert.equal((await execute("ses_B", { action: "screenshot" }, { pin: fresh.pin })).statusCode, 200)
    assert.equal(restarts, 1)
  })

  it("only recovers an uncertain CDP run with a fresh inspection and new document", async () => {
    const client = new FakeChrome().client()
    const exact = { recoverUncertainRun: true }
    try {
      const previous = await client.inspect(identity)
      client.close(identity.runId, true)
      await assert.rejects(client.inspect(identity), /run is closed/)
      await assert.rejects(client.inspect(identity, { ...exact, ref: refOf(previous) }), /run is closed/)
      await assert.rejects(client.inspect({ ...identity, document: previous.document }, exact), /run is closed/)
      const recovered = await client.inspect(identity, exact)
      assert.notEqual(recovered.document, previous.document)
      await assert.rejects(client.screenshot({ ...identity, document: previous.document }), StaleDeveloperDocument)
      await client.screenshot({ ...identity, document: recovered.document })
      client.close(identity.runId)
      await assert.rejects(client.inspect(identity, exact), /run is closed/)
    } finally { client.close() }
  })

  it("does not publish an inspection through a partially initialized CDP socket", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client({ timeoutMs: 40 })
    try {
      chrome.skipReply = command => command.method === "Page.getFrameTree"
      await assert.rejects(client.inspect(identity), /Page.getFrameTree timed out/)
      const incomplete = chrome.sockets.at(-1)
      assert.ok(incomplete?.closed)
      chrome.skipReply = undefined
      const { document } = await client.inspect(identity)
      assert.notEqual(chrome.sockets.at(-1), incomplete)
      assert.ok(chrome.commands.some(command => command.method === "Runtime.enable"))
      const socket = chrome.sockets.at(-1)!
      const context = (id: number) => ({ context: { id, auxData: { isDefault: true, frameId: "main" } } })
      socket.emit("Runtime.executionContextCreated", context(1))
      socket.emit("Runtime.executionContextCreated", context(2))
      await assert.rejects(client.screenshot({ ...identity, document }), /Page changed/)
      assert.ok(chrome.commands.every(command => command.method !== "Page.captureScreenshot"))
    } finally { client.close() }
  })

  it("does not reopen a retired run for an inspection already in its queue", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    try {
      await client.inspect(identity)
      chrome.deferred.set("Accessibility.getFullAXTree", undefined as never)
      const active = assert.rejects(client.inspect(identity), /retired|closed/i)
      while (!chrome.deferred.get("Accessibility.getFullAXTree")) await new Promise<void>(resolve => setImmediate(resolve))
      const queued = assert.rejects(client.inspect(identity), /retired|closed/i)
      chrome.deferred.clear()
      const connections = chrome.sockets.length
      client.close(identity.runId)
      await Promise.all([active, queued])
      assert.equal(chrome.sockets.length, connections)
      await client.inspect({ ...identity, runId: "next-run" })
    } finally { client.close() }
  })

  it("retires the pin when a new main context arrives before the old context is destroyed", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    try {
      await client.inspect(identity)
      const socket = chrome.sockets.at(-1)!
      const context = (id: number) => ({ context: { id, auxData: { isDefault: true, frameId: "main" } } })
      socket.emit("Runtime.executionContextCreated", context(1))
      const { document } = await client.inspect(identity)
      socket.emit("Runtime.executionContextCreated", context(2))
      socket.emit("Runtime.executionContextDestroyed", { executionContextId: 1 })
      await assert.rejects(client.act({ ...identity, document }, { action: "press", key: "Enter" }), /Page changed/)
      assert.ok(chrome.commands.every(command => !command.method.startsWith("Input.")))
    } finally { client.close() }
  })

  it("fences destruction of the future main world announced before frame navigation", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    try {
      await client.inspect(identity)
      const socket = chrome.sockets.at(-1)!
      socket.emit("Runtime.executionContextCreated", { context: { id: 5, auxData: { isDefault: true, frameId: "next-main" } } })
      socket.emit("Page.frameNavigated", { frame: { id: "next-main" } })
      const { document } = await client.inspect(identity)
      socket.emit("Runtime.executionContextDestroyed", { executionContextId: 5 })
      await assert.rejects(client.screenshot({ ...identity, document }), /Page changed/)
    } finally { client.close() }
  })

  for (const run of [true, false]) it(`closes active discovery sockets (run scope: ${run})`, async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    chrome.deferred.set("Runtime.evaluate", undefined as never)
    try {
      const inspect = assert.rejects(client.inspect(identity), /retired|closed/i)
      const windows = new Map([[identity.windowId, undefined]])
      const inventory = client.probeContexts(identity, windows)
      const otherInventory = client.probeContexts({ ...identity, runId: "other-run" }, windows)
      while (chrome.commands.length < 3) await new Promise<void>(resolve => setImmediate(resolve))
      client.close(run ? identity.runId : undefined)
      const sockets = [...chrome.sockets]
      assert.equal(sockets.filter(socket => socket.closed).length, run ? 2 : 3)
      await inspect
      assert.equal((await inventory).size, 0)
      assert.equal((await client.probeContexts(identity, windows)).size, 0, "a retired inventory cannot reopen its sockets")
      assert.equal(chrome.sockets.length, sockets.length)
      if (run) client.close()
      assert.equal((await otherInventory).size, 0)
    } finally { client.close() }
  })

  it("cancels the discovery connection handshake when the run closes", async () => {
    const chrome = new FakeChrome()
    let opening!: () => void
    const started = new Promise<void>(resolve => { opening = resolve })
    const socket = { onopen: null, send() { assert.fail("retired probe sent a command") }, close() { closed = true } }
    let closed = false
    const client = chrome.client({ connect: () => { opening(); return socket } })
    try {
      const inspection = assert.rejects(client.inspect(identity), /retired|closed/i)
      await started
      client.close(identity.runId)
      assert.equal(closed, true)
      await inspection
    } finally { client.close() }
  })

  for (const changed of ["tab", "root"]) it(`refuses boxless activation when the ${changed} changes during the script call`, async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    try {
      const snapshot = await client.inspect(identity)
      chrome.onCommand = command => {
        if (isScriptClick(command) && String(command.params?.functionDeclaration).includes("codenomad:has-box")) {
          if (changed === "tab") chrome.context.tabId = "another-tab"
          else chrome.inputRootCurrent = false
        }
      }
      await assert.rejects(client.act({ ...identity, document: snapshot.document }, { action: "click", ref: refOf(snapshot) }),
        changed === "tab" ? /active tab changed/ : /Page changed during action/)
      assert.equal(chrome.scriptClicks, 0)
    } finally { client.close() }
  })

  it("does not reopen a window retired while discovering targets for the same run", async () => {
    const chrome = new FakeChrome()
    let hold: (() => void) | undefined, started: (() => void) | undefined
    const blocked = new Promise<void>(resolve => { hold = resolve })
    const listing = new Promise<void>(resolve => { started = resolve })
    let deferList = false
    const client = chrome.client({ fetch: async (url: string) => {
      if (deferList) { started!(); await blocked }
      return chrome.fetch(url)
    } })
    try {
      await client.inspect(identity)
      const count = chrome.sockets.length
      chrome.context.windowId = "window-2"
      deferList = true
      const other = client.inspect({ ...identity, windowId: "window-2" })
      await listing
      client.close(identity.runId)
      hold!()
      await assert.rejects(other, /retired|closed/i)
      assert.equal(chrome.sockets.length, count, "discovery must not open even a probe for the retired state")
      assert.ok(chrome.sockets.every(socket => socket.closed))
    } finally { client.close() }
  })

  it("releases only admitted keys after an unrelated tab change", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const { endpoint, runId, windowId } = identity
    const window = { endpoint, runId, windowId }
    try {
      const { document } = await client.inspect(window)
      chrome.onCommand = command => {
        if (command.method === "Input.dispatchKeyEvent" && command.params?.code === "ControlLeft"
          && command.params.type !== "keyUp") chrome.context = { ...chrome.context, instanceId: "next-tab" }
      }
      await assert.rejects(client.act({ ...window, document }, { action: "press", key: "Control+]" }), /active tab changed/)
      const keys = chrome.commands.filter(command => command.method === "Input.dispatchKeyEvent")
      assert.deepEqual(keys.map(command => [command.params?.code, command.params?.type]),
        [["ControlLeft", "rawKeyDown"], ["ControlLeft", "keyUp"]])
    } finally { client.close() }
  })

  it("completes an admitted click when the press changes the tab in the same document", async () => {
    const chrome = new FakeChrome()
    chrome.quads = [[100, 40, 300, 40, 300, 80, 100, 80]]
    const client = chrome.client()
    try {
      const { endpoint, runId, windowId } = identity
      const window = { endpoint, runId, windowId }
      const inspection = await client.inspect(window)
      chrome.onCommand = command => {
        if (command.method === "Input.dispatchMouseEvent" && command.params?.type === "mousePressed") {
          chrome.context = { ...chrome.context, instanceId: "next-tab" }
        }
      }
      await client.act({ ...window, document: inspection.document }, { action: "click", ref: refOf(inspection) })
      assert.deepEqual(chrome.commands.filter(command => command.method === "Input.dispatchMouseEvent")
        .map(command => command.params?.type), ["mouseMoved", "mousePressed", "mouseReleased"])
    } finally { client.close() }
  })

  it("reports uncertain input when the socket closes after sending a key", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    try {
      const { endpoint, runId, windowId } = identity
      const window = { endpoint, runId, windowId }
      const { document } = await client.inspect(window)
      chrome.onCommand = command => {
        if (command.method === "Input.dispatchKeyEvent") chrome.sockets.at(-1)!.close()
      }
      await assert.rejects(client.act({ ...window, document }, { action: "press", key: "Enter" }), /Input already sent/)
      assert.equal(chrome.commands.filter(command => command.method === "Input.dispatchKeyEvent").length, 1)
    } finally { client.close() }
  })

  it("reports that the key was sent if its follow-up focus read loses the document", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    try {
      const { endpoint, runId, windowId } = identity
      const window = { endpoint, runId, windowId }
      const { document } = await client.inspect(window)
      chrome.onCommand = command => {
        if (command.method === "Runtime.evaluate" && command.params?.objectGroup && !isInputState(command)) chrome.sockets.at(-1)!.close()
      }
      await assert.rejects(client.act({ ...window, document }, { action: "press", key: "Enter" }), /Key input was sent/)
      assert.equal(chrome.commands.filter(command => command.method === "Input.dispatchKeyEvent").length, 2)
    } finally { client.close() }
  })

  for (const reply of [{ exceptionDetails: { text: "Focus read failed" } }, {}]) {
    it(`reports an explicit post-press failure for ${Object.keys(reply)[0] ?? "missing focus"}`, async () => {
      const chrome = new FakeChrome()
      const client = chrome.client()
      try {
        chrome.activeElementReply = reply
        const { document } = await client.inspect(identity)
        await assert.rejects(client.act({ ...identity, document }, { action: "press", key: "Enter" }), /Key input was sent.*focus could not be read/i)
        assert.equal(chrome.commands.filter(command => command.method === "Input.dispatchKeyEvent").length, 2)
      } finally { client.close() }
    })
  }

  for (const receiverChanges of [false, true]) it(`rechecks an unsent release after a timeout (receiver changed: ${receiverChanges})`, async () => {
    const chrome = new FakeChrome()
    chrome.quads = [[100, 40, 300, 40, 300, 80, 100, 80]]
    const client = chrome.client({ timeoutMs: 40 })
    try {
      const inspection = await client.inspect(identity)
      let checks = 0
      chrome.skipReply = command => {
        if (!isDestination(command) || !(command.params!.arguments as Array<{ value: unknown }>)[2].value || ++checks !== 1) return false
        if (receiverChanges) chrome.receiver++
        return true
      }
      await assert.rejects(client.act({ ...identity, document: inspection.document }, {
        action: "click", ref: refOf(inspection),
      }), /destination check timed out/)
      assert.equal(checks, 2)
      assert.deepEqual(chrome.commands.filter(command => command.method === "Input.dispatchMouseEvent")
        .map(command => command.params?.type), receiverChanges ? ["mouseMoved", "mousePressed"] : ["mouseMoved", "mousePressed", "mouseReleased"])
    } finally { client.close() }
  })

  it("does not release at an unproven intermediate drag point", async () => {
    const chrome = new FakeChrome()
    Object.assign(chrome.axNodes[0], { nodeId: "source", parentId: "root" })
    chrome.axNodes.unshift({ nodeId: "root", role: { value: "RootWebArea" }, childIds: ["source", "drop"] })
    chrome.axNodes.push({ nodeId: "drop", parentId: "root", backendDOMNodeId: 43, role: { value: "button" }, name: { value: "Drop" } })
    chrome.hit = 43
    chrome.quads = [[100, 40, 300, 40, 300, 80, 100, 80]]
    const client = chrome.client({ timeoutMs: 40 })
    try {
      const inspection = await client.inspect(identity)
      chrome.skipReply = command => command.method === "Input.dispatchMouseEvent"
        && command.params?.type === "mouseMoved" && command.params?.buttons === 1
      await assert.rejects(client.act({ ...identity, document: inspection.document }, {
        action: "drag", ref: refOf(inspection), to: /button "Drop" \[(e\d+)\]/.exec(inspection.snapshot)![1],
      }), /outcome is unknown/)
      assert.ok(chrome.commands.every(command => command.params?.type !== "mouseReleased"))
    } finally { client.close() }
  })

  it("does not release an admitted key after the main execution contexts are cleared", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const { endpoint, runId, windowId } = identity
    const window = { endpoint, runId, windowId }
    try {
      const { document } = await client.inspect(window)
      chrome.onCommand = command => {
        if (command.method === "Input.dispatchKeyEvent" && command.params?.code === "ControlLeft"
          && command.params.type !== "keyUp") {
          chrome.sockets.at(-1)!.emit("Runtime.executionContextsCleared")
        }
      }
      await assert.rejects(client.act({ ...window, document }, { action: "press", key: "Control+]" }), /changed during action/)
      const keys = chrome.commands.filter(command => command.method === "Input.dispatchKeyEvent")
      assert.deepEqual(keys.map(command => command.params?.code), ["ControlLeft"])
    } finally { client.close() }
  })

  it("refuses keyboard input when a child document has focus after its replacement", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    try {
      chrome.mainFocus = false
      const { document } = await client.inspect(identity)
      chrome.sockets.at(-1)!.emit("Page.frameNavigated", { frame: { id: "child", parentId: "main" } })
      await assert.rejects(client.act({ ...identity, document }, { action: "press", key: "Enter" }), (error: Error) => {
        assert.match(error.message, /focus.*outside the main document/i)
        assert.doesNotMatch(error.message, /input already sent|outcome is unknown/i)
        return true
      })
      assert.ok(!chrome.commands.some(command => command.method === "Input.dispatchKeyEvent"))
    } finally { client.close() }
  })

  it("does not send keyUp to a child document that takes focus during keyDown", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    try {
      const { document } = await client.inspect(identity)
      chrome.onCommand = command => {
        if (command.method === "Input.dispatchKeyEvent" && command.params?.type === "keyDown") chrome.mainFocus = false
      }
      await assert.rejects(client.act({ ...identity, document }, { action: "press", key: "Enter" }), /focus.*outside the main document.*Input already sent/i)
      assert.deepEqual(chrome.commands.filter(command => command.method === "Input.dispatchKeyEvent")
        .map(command => command.params?.type), ["keyDown"])
      assert.ok(chrome.commands.some(command => command.params?.objectId === "input-document"
        && String(command.params.functionDeclaration).includes("Math.min")))
    } finally { client.close() }
  })

  for (const mouse of [false, true]) for (const cleanup of [false, true]) {
    it(`requires a fresh ${mouse ? "pointer" : "keyboard"} destination for ${cleanup ? "cleanup" : "the scheduled release"}`, async () => {
      const chrome = new FakeChrome()
      chrome.quads = [[100, 40, 300, 40, 300, 80, 100, 80]]
      const client = chrome.client({ timeoutMs: 40 })
      try {
        const inspection = await client.inspect(identity)
        const down = mouse ? "mousePressed" : "keyDown"
        chrome.skipReply = command => {
          if (cleanup && command.params?.type === down) return true
          if (!isDestination(command) || !chrome.commands.some(previous => previous.params?.type === down)) return false
          // An existing iframe can take focus or cover the point without a CDP frame event.
          chrome.mainFocus = false
          chrome.hitTag = "iframe"
          return true
        }
        const result = client.act({ ...identity, document: inspection.document }, mouse
          ? { action: "click", ref: refOf(inspection) } : { action: "press", key: "Enter" })
        const failure = await result.catch((error: Error) => error.message)
        assert.deepEqual(chrome.commands.filter(command => command.method.startsWith("Input."))
          .map(command => command.params?.type), mouse ? ["mouseMoved", down] : [down])
        assert.match(String(failure), /outcome is unknown|Input already sent/)
      } finally { client.close() }
    })
  }

  for (const isDefault of [true, false]) it(`fences loss of the main world only (default: ${isDefault})`, async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    try {
      const { document } = await client.inspect(identity)
      const socket = chrome.sockets.at(-1)!
      socket.emit("Runtime.executionContextCreated", { context: { id: 5, auxData: { isDefault, frameId: "main" } } })
      socket.emit("Runtime.executionContextDestroyed", { executionContextId: 5 })
      const press = client.act({ ...identity, document }, { action: "press", key: "Enter" })
      if (isDefault) await assert.rejects(press, /Page changed/)
      else await press
      assert.equal(chrome.commands.filter(command => command.method === "Input.dispatchKeyEvent").length, isDefault ? 0 : 2)
    } finally { client.close() }
  })

  it("refuses a child-frame keyboard ref before calling a page function on it", async () => {
    const chrome = new FakeChrome()
    chrome.mainRef = false
    const client = chrome.client()
    try {
      const inspection = await client.inspect(identity)
      await assert.rejects(client.act({ ...identity, document: inspection.document }, {
        action: "press", key: "Enter", ref: refOf(inspection),
      }), /does not support keyboard input into a subframe/)
      assert.equal(chrome.commands.filter(command => command.params?.objectId === "node-1").length, 1)
      assert.ok(!chrome.commands.some(command => command.method === "Input.dispatchKeyEvent"))
    } finally { client.close() }
  })

  for (const retargeted of [false, true]) it(`releases an admitted mouse press only if its point stays in the main frame (retargeted: ${retargeted})`, async () => {
    const chrome = new FakeChrome()
    chrome.quads = [[100, 40, 300, 40, 300, 80, 100, 80]]
    const client = chrome.client()
    try {
      const inspection = await client.inspect(identity)
      const socket = chrome.sockets.at(-1)!
      socket.emit("Runtime.executionContextCreated", { context: { id: 5, auxData: { isDefault: true, frameId: "main" } } })
      socket.emit("Runtime.executionContextCreated", { context: { id: 6, auxData: { isDefault: true, frameId: "unrelated-child" } } })
      chrome.onCommand = command => {
        if (command.method !== "Input.dispatchMouseEvent" || command.params?.type !== "mousePressed") return
        socket.emit("Runtime.executionContextDestroyed", { executionContextId: 6 })
        socket.emit("Page.frameDetached", { frameId: "unrelated-child", reason: "remove" })
        if (retargeted) chrome.hitTag = "iframe" // Out-of-process frames are reported as their owner in the main frame.
      }
      const click = client.act({ ...identity, document: inspection.document }, { action: "click", ref: refOf(inspection) })
      if (retargeted) await assert.rejects(click, /pointer.*main document.*Input already sent/i)
      else await click
      assert.deepEqual(chrome.commands.filter(command => command.method === "Input.dispatchMouseEvent")
        .map(command => command.params?.type), retargeted ? ["mouseMoved", "mousePressed"] : ["mouseMoved", "mousePressed", "mouseReleased"])
      assert.ok(chrome.commands.some(command => command.params?.objectId === "input-document"
        && String(command.params.functionDeclaration).includes("Math.min")))
    } finally { client.close() }
  })

  it("checks the live frame at the release point even before Page reports navigation", async () => {
    const chrome = new FakeChrome()
    chrome.quads = [[100, 40, 300, 40, 300, 80, 100, 80]]
    const client = chrome.client()
    try {
      const inspection = await client.inspect(identity)
      const socket = chrome.sockets.at(-1)!
      socket.emit("Runtime.executionContextCreated", { context: { id: 6, auxData: { isDefault: true, frameId: "child" } } })
      chrome.onCommand = command => {
        if (isDestination(command) && chrome.commands.some(previous => previous.params?.type === "mousePressed")) {
          socket.emit("Runtime.executionContextDestroyed", { executionContextId: 6 })
          chrome.hitFrame = "child"
        }
      }
      await assert.rejects(client.act({ ...identity, document: inspection.document }, {
        action: "click", ref: refOf(inspection),
      }), /pointer.*main document.*Input already sent/i)
      assert.deepEqual(chrome.commands.filter(command => command.method === "Input.dispatchMouseEvent")
        .map(command => command.params?.type), ["mouseMoved", "mousePressed"])
      assert.ok(chrome.commands.some(command => command.params?.objectId === "input-document"
        && String(command.params.functionDeclaration).includes("Math.min")))
    } finally { client.close() }
  })

  for (const during of ["mark", "destination"]) it(`does not release the mouse after explicit root loss during ${during}`, async () => {
    const chrome = new FakeChrome()
    chrome.quads = [[100, 40, 300, 40, 300, 80, 100, 80]]
    const client = chrome.client()
    try {
      const inspection = await client.inspect(identity)
      chrome.onCommand = command => {
        if (during === "mark" && command.method === "Input.dispatchMouseEvent" && command.params?.type === "mousePressed"
          || during === "destination" && isDestination(command) && chrome.commands.some(previous => previous.params?.type === "mousePressed")) {
          chrome.inputRootCurrent = false
        }
      }
      await assert.rejects(client.act({ ...identity, document: inspection.document }, {
        action: "click", ref: refOf(inspection),
      }), /Input already sent/)
      assert.deepEqual(chrome.commands.filter(command => command.method === "Input.dispatchMouseEvent")
        .map(command => command.params?.type), ["mouseMoved", "mousePressed"])
    } finally { client.close() }
  })

  it("keeps an admitted mouse release through two unrelated iframe changes during its hit checks", async () => {
    const chrome = new FakeChrome()
    chrome.quads = [[100, 40, 300, 40, 300, 80, 100, 80]]
    const client = chrome.client()
    try {
      const inspection = await client.inspect(identity)
      let unrelated = 0
      chrome.onCommand = command => {
        if (isDestination(command)
          && chrome.commands.some(previous => previous.params?.type === "mousePressed")) {
          for (const id of ["child-1", "child-2"]) {
            chrome.sockets.at(-1)!.emit("Page.frameNavigated", { frame: { id, parentId: "main" } })
            unrelated++
          }
        }
      }
      await client.act({ ...identity, document: inspection.document }, { action: "click", ref: refOf(inspection) })
      assert.equal(unrelated, 2)
      assert.deepEqual(chrome.commands.filter(command => command.method === "Input.dispatchMouseEvent")
        .map(command => command.params?.type), ["mouseMoved", "mousePressed", "mouseReleased"])
    } finally { client.close() }
  })

  it("completes key releases in the same document after a tab-switch chord", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const { endpoint, runId, windowId } = identity
    const window = { endpoint, runId, windowId }
    let selected = true
    try {
      const { document } = await client.inspect(window)
      chrome.onCommand = command => {
        if (command.method === "Input.dispatchKeyEvent" && command.params?.code === "BracketRight"
          && command.params?.type !== "keyUp") {
          chrome.context = { ...chrome.context, instanceId: "next-tab" }
          selected = false
        }
      }
      await client.act({ ...window, document }, { action: "press", key: "Control+]" }, () => {
        if (!selected) throw new Error("Newer inspection won")
      })
      const keys = chrome.commands.filter(command => command.method === "Input.dispatchKeyEvent")
      assert.deepEqual(keys.filter(command => command.params?.type === "keyUp").map(command => command.params?.code),
        ["BracketRight", "ControlLeft"])
    } finally { client.close() }
  })

  it("refuses a key without a ref when the foreground tab changes before input", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    try {
      const { endpoint, runId, windowId } = identity
      const window = { endpoint, runId, windowId }
      const { document } = await client.inspect(window)
      chrome.onCommand = command => {
        if (command.method === "Runtime.callFunctionOn" && command.params?.objectId === "input-document") {
          chrome.context = { ...chrome.context, instanceId: "duplicate" }
        }
      }
      await assert.rejects(client.act({ ...window, document }, { action: "press", key: "Enter" }), /active tab changed/)
      assert.ok(chrome.commands.every(command => command.method !== "Input.dispatchKeyEvent"))
    } finally { client.close() }
  })

  it("refuses a new key when the tab changes during the final focus read", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    try {
      const { document } = await client.inspect(identity)
      chrome.onCommand = command => {
        if (isDestination(command)) {
          chrome.context = { ...chrome.context, tabId: "duplicate" }
        }
      }
      await assert.rejects(client.act({ ...identity, document }, { action: "press", key: "Enter" }), (error: Error) => {
        assert.match(error.message, /active tab changed/)
        assert.doesNotMatch(error.message, /input already sent|outcome is unknown/i)
        return true
      })
      assert.ok(chrome.commands.every(command => command.method !== "Input.dispatchKeyEvent"))
    } finally { client.close() }
  })

  it("refuses a new key when its inspection is superseded during the final focus read", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    let selected = true
    try {
      const { document } = await client.inspect(identity)
      chrome.onCommand = command => {
        if (isDestination(command)) selected = false
      }
      await assert.rejects(client.act({ ...identity, document }, { action: "press", key: "Enter" }, () => {
        if (!selected) throw new Error("Newer inspection won")
      }), { message: "Newer inspection won" })
      assert.ok(chrome.commands.every(command => command.method !== "Input.dispatchKeyEvent"))
    } finally { client.close() }
  })

  it("binds provenance to the document observed before its marking command", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const { endpoint, runId, windowId } = identity
    const window = { endpoint, runId, windowId }
    try {
      const { document } = await client.inspect(window)
      chrome.onCommand = command => {
        if (isInputState(command)) {
          chrome.sockets.at(-1)!.emit("Page.documentOpened", { frame: { id: "main" } })
        }
      }
      await assert.rejects(client.act({ ...window, document }, { action: "press", key: "Enter" }), /changed during action/)
      assert.ok(chrome.commands.every(command => command.method !== "Input.dispatchKeyEvent"
        && !JSON.stringify(command.params)?.includes("__codenomadAutomationInputUntil")))
    } finally { client.close() }
  })

  it("skips unresponsive inventory pages and checks the window incarnation before reading", async () => {
    const chrome = new FakeChrome(), stalled = new FakeChrome()
    stalled.target = page("stalled")
    const workers = Array.from({ length: 64 }, (_, index) => ({ ...page(`worker-${index}`), type: "service_worker" }))
    chrome.targets = [...workers, stalled.target, chrome.target]
    stalled.deferred.set("Runtime.evaluate", undefined as never)
    chrome.context.windowInstance = "current"
    const client = chrome.client({ connect: (url: string) => url.endsWith("/stalled") ? stalled.connect(url) : chrome.connect(url) })
    try {
      const windows = new Map([[identity.windowId, "current"]])
      assert.equal((await client.probeContexts(identity, windows)).size, 1)
      const retired = new FakeChrome()
      retired.target = page("retired")
      retired.context.windowInstance = "retired"
      const reopened = chrome.client({ connect: (url: string) => url.endsWith("/retired") ? retired.connect(url) : chrome.connect(url) })
      chrome.targets = [retired.target, chrome.target]
      try {
        assert.equal((await reopened.probeContexts(identity, windows)).get(identity.windowId)?.windowInstance, "current")
      } finally { reopened.close() }
      chrome.targets = [stalled.target, chrome.target]
      await assert.rejects(client.inspect({ ...identity, windowInstance: "retired" }), /No CodeNomad page matches/)
      assert.ok(chrome.commands.every(command => command.method !== "Accessibility.getFullAXTree"))
      assert.equal((await client.inspect({ ...identity, windowInstance: "current" })).context.windowId, identity.windowId)
    } finally { client.close() }
  })

  it("never resolves a ref issued by a different backend", async () => {
    const chrome = new FakeChrome()
    const first = chrome.client(), second = chrome.client()
    try {
      const a = refOf(await first.inspect(identity))
      const b = refOf(await second.inspect(identity))
      assert.notEqual(a, b)
      await assert.rejects(second.act(identity, { action: "click", ref: a }), /stale ref/)
    } finally { first.close(); second.close() }
  })

  it("preserves live refs across inspections of distinct windows in the same run", async () => {
    const first = new FakeChrome(), second = new FakeChrome()
    second.target = page("two")
    second.context = { ...first.context, windowId: "window-2" }
    first.targets = [first.target, second.target]
    const client = first.client({ connect: (url: string) => url.endsWith("/two") ? second.connect(url) : first.connect(url) })
    const other = { ...identity, windowId: "window-2" }
    try {
      const a = await client.inspect(identity)
      const b = await client.inspect(other)
      await client.act({ ...identity, document: a.document }, { action: "click", ref: refOf(a) })
      await assert.rejects(client.act(other, { action: "click", ref: refOf(a) }), /stale ref/)
      await client.act({ ...other, document: b.document }, { action: "click", ref: refOf(b) })
      first.sockets.find(socket => !socket.closed)!.emit("Page.frameNavigated", { frame: { parentId: "root" } })
      assert.equal((await client.screenshot({ ...identity, document: a.document })).bytes, 3)
      first.sockets.find(socket => !socket.closed)!.emit("Page.frameNavigated")
      await assert.rejects(client.screenshot({ ...identity, document: a.document }), /Page changed/)
      assert.equal((await client.screenshot({ ...other, document: b.document })).bytes, 3)
    } finally { client.close() }
  })

  it("does not queue a ready window behind a different window in the same run", async () => {
    const first = new FakeChrome(), second = new FakeChrome()
    second.target = page("two")
    second.context = { ...first.context, windowId: "window-2" }
    first.targets = [first.target, second.target]
    first.deferred.set("Accessibility.getFullAXTree", undefined as never)
    const client = first.client({ connect: (url: string) => url.endsWith("/two") ? second.connect(url) : first.connect(url) })
    const a = client.inspect(identity)
    let limit: NodeJS.Timeout | undefined
    try {
      while (!first.deferred.get("Accessibility.getFullAXTree")) await new Promise<void>(resolve => setImmediate(resolve))
      const b = client.inspect({ ...identity, windowId: "window-2" })
      const completed = await Promise.race([b, new Promise<never>((_, reject) => {
        limit = setTimeout(() => reject(new Error("B waited for A")), 750)
      })])
      assert.equal(completed.context.windowId, "window-2")
    } finally {
      clearTimeout(limit)
      const read = first.deferred.get("Accessibility.getFullAXTree")
      read?.socket.respond(read.command, first.result("Accessibility.getFullAXTree"))
      await a.catch(() => {})
      client.close()
    }
  })

  it("keeps window-scoped tools usable across session/project navigation and empty views", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const window = { endpoint: identity.endpoint, runId: identity.runId, windowId: identity.windowId }
    try {
      const first = await client.inspect(window)
      chrome.context = { ...chrome.context, sessionId: "another-session", instanceId: "another-project" }
      await client.act(window, { action: "click", ref: refOf(first) })
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

  it("checks a queued reconnect before reading the same window lane", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    let pinned = false
    try {
      chrome.deferred.set("Accessibility.getFullAXTree", undefined as never)
      const inspecting = client.inspect(identity)
      while (!chrome.deferred.get("Accessibility.getFullAXTree")) await new Promise<void>(resolve => setImmediate(resolve))
      const reconnecting = client.inspect(identity, {}, { beforeRead: () => {
        if (pinned) throw new Error("Newer inspection won")
      } })
      const rejected = assert.rejects(reconnecting, /Newer inspection won/)
      pinned = true
      const read = chrome.deferred.get("Accessibility.getFullAXTree")!
      read.socket.respond(read.command, chrome.result("Accessibility.getFullAXTree"))
      const inspected = await inspecting
      await rejected
      assert.equal(chrome.sockets.at(-1)?.closed, false)
      await client.act(identity, { action: "click", ref: refOf(inspected) })
    } finally { client.close() }
  })

  it("checks queued actions and captures before touching a newer inspection's CDP target", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    let replaced = false
    const checkAdmission = () => { if (replaced) throw new Error("Newer inspection won") }
    try {
      chrome.deferred.set("Accessibility.getFullAXTree", undefined as never)
      const inspection = client.inspect(identity)
      while (!chrome.deferred.get("Accessibility.getFullAXTree")) await new Promise<void>(resolve => setImmediate(resolve))
      const failures = Promise.all([
        assert.rejects(client.act(identity, { action: "press", key: "Enter" }, checkAdmission), /Newer inspection won/),
        assert.rejects(client.screenshot(identity, checkAdmission), /Newer inspection won/),
      ])
      replaced = true
      const read = chrome.deferred.get("Accessibility.getFullAXTree")!
      read.socket.respond(read.command, chrome.result("Accessibility.getFullAXTree"))
      const result = await inspection
      await failures
      assert.equal(chrome.sockets.at(-1)?.closed, false)
      assert.equal(chrome.commands.some(command => command.method.startsWith("Input.") || command.method === "Page.captureScreenshot"), false)
      await client.act(identity, { action: "click", ref: refOf(result) })
    } finally { client.close() }
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
    await assert.rejects(client.act(identity, { action: "click", ref: oldRef }), /stale ref/)
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

  it("clicks a visible element with marked real pointer input at its visible centre", async () => {
    const chrome = new FakeChrome()
    chrome.quads = [[100, 40, 300, 40, 300, 80, 100, 80]]
    const client = chrome.client()
    const inspection = await client.inspect(identity)
    chrome.commands.length = 0

    await client.act(identity, { action: "click", ref: refOf(inspection) })

    const sequence = chrome.commands.filter(command => command.method === "Input.dispatchMouseEvent"
      || (command.method === "Runtime.callFunctionOn" && command.params?.objectId === "input-document" && !isDestination(command) && !isScriptClick(command)))
      .map(command => command.method === "Runtime.callFunctionOn" ? (/Math.min/.test(String(command.params!.functionDeclaration)) ? "unmark" : "mark")
        : `${command.params!.type}@${command.params!.x},${command.params!.y}`)
    assert.deepEqual(sequence, ["mark", "mouseMoved@200,60", "mark", "mousePressed@200,60", "mark", "mouseReleased@200,60", "unmark"],
      "every trusted event in the CodeNomad window is marked, and the mark is cleared")
  })

  it("refuses a covered element and activates a box-less one programmatically", async () => {
    const chrome = new FakeChrome()
    chrome.quads = [[0, 0, 10, 0, 10, 10, 0, 10]]
    chrome.hit = 7
    const client = chrome.client()
    const inspection = await client.inspect(identity)
    chrome.commands.length = 0
    chrome.functionResult = "div \"Overlay\""
    await assert.rejects(client.act(identity, { action: "click", ref: refOf(inspection) }), /is covered by div "Overlay"; close or move it first/)
    assert.equal(chrome.commands.some(command => command.method === "Input.dispatchMouseEvent"), false)

    chrome.functionResult = undefined
    chrome.quads = []
    chrome.commands.length = 0
    await client.act(identity, { action: "click", ref: refOf(inspection) })
    assert.equal(chrome.commands.some((command) => command.method === "Input.dispatchMouseEvent"), false)
    assert.equal(chrome.scriptClicks, 1)
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
      client.act(identity, { action: "type", ref: refOf(inspection), text: "hello", clear: true }),
      /stale ref/,
    )
  })

  it("retires a pinned renderer document only when its main document is reopened", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    try {
      const { document } = await client.inspect(identity)
      const pinned = { ...identity, document }
      const socket = chrome.sockets.at(-1)!
      socket.emit("Page.documentOpened", { frame: { id: "child", parentId: "main" } })
      await client.context(pinned)
      socket.emit("Page.documentOpened", { frame: { id: "main" } })
      await assert.rejects(client.context(pinned), StaleDeveloperDocument)
    } finally { client.close() }
  })

  it("invalidates refs when the target socket reconnects", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    const inspection = await client.inspect(identity)
    chrome.sockets.at(-1)!.close()

    await assert.rejects(
      client.act(identity, { action: "click", ref: refOf(inspection) }),
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
      client.act(identity, { action: "click", ref: refOf(inspection) }),
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

    await assert.rejects(client.act(identity, { action: "click", ref: oldRef }), /stale ref/)
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
    const action = client.act(identity, { action: "click", ref: refOf(inspection) })
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
    const action = client.act(identity, { action: "click", ref: refOf(inspection) })
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
    await client.act(identity, { action: "click", ref: save })
    assert.match((await client.inspect(identity, { query: "save" })).snapshot, new RegExp(`button "Save" \\[${save}\\]`))
    assert.equal(/button "Save" \[(e\d+)\]/.exec((await client.inspect(identity)).snapshot)![1], save)

    // A later inspection of the same page never invalidates an earlier ref; a node that
    // left the page is reported as such, not as a stale ref.
    chrome.axNodes = chrome.axNodes.filter(node => !["dialog", "field"].includes(node.nodeId as string))
    chrome.axNodes[0] = { ...chrome.axNodes[0], childIds: ["toolbar"] }
    await client.inspect(identity)
    await assert.rejects(client.inspect(identity, { ref: dialog }), /is no longer in the page/)
    await client.act(identity, { action: "click", ref: dialog })
    chrome.sockets.at(-1)!.emit("Page.frameNavigated", { frame: { id: "main" } })
    await assert.rejects(client.act(identity, { action: "click", ref: save }), /stale ref/)
  })

  it("closes active target connections", async () => {
    const chrome = new FakeChrome()
    const client = chrome.client()
    await client.inspect(identity)
    client.close()
    assert.equal(chrome.sockets.at(-1)!.closed, true)
  })
})
