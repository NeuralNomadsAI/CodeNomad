import assert from "node:assert/strict"
import { test } from "node:test"
import { BrowserPage } from "./browser-page"
import { executeCdpOperation } from "./page/cdp-driver"
import type { PageOperation } from "./page/protocol"

class Native {
  generation = "run/guest/document-1"
  hidden = false
  failMethod?: string
  fileInput = false
  loseBeginReply = false
  calls: Array<{ method: string; input: Record<string, any> }> = []
  protocol: Array<{method: string; params: Record<string, unknown>}> = []
  gate?: () => Promise<void>
  quads: number[][] = []
  onInput?: (type: unknown) => void
  leases = new Map<string, string>()
  nodes = [{ nodeId: "one", backendDOMNodeId: 42, role: { value: "button" }, name: { value: "Save" } }]
  request = async <T>(method: string, input: Record<string, any>): Promise<T> => {
    this.calls.push({ method, input })
    if (method === "browser.page.end") { this.leases.delete(input.operationID); return {} as T }
    if (this.hidden) throw new Error("No visible browser")
    if (method === "browser.page.begin") {
      this.leases.set(input.operationID, this.generation)
      if (this.loseBeginReply) throw new Error("Begin reply lost")
      return { generation: this.generation, url: "https://example.test/", driver: "cdp", contractVersion: 1 } as T
    }
    if (input.generation !== this.generation || this.leases.get(input.operationID) !== this.generation) throw new Error("Browser document changed")
    if (method === "browser.page.check") return { url: "https://example.test/" } as T
    return await executeCdpOperation({ send: async (method, params = {}) => {
      this.protocol.push({method, params})
      if (method === this.failMethod) throw new Error("Native reply uncertain")
      if (method === "Accessibility.getFullAXTree") { await this.gate?.(); return { nodes: this.nodes } }
      if (method === "DOM.resolveNode") return { object: { objectId: "object-1" } }
      if (method === "DOM.getContentQuads") return { quads: this.quads }
      if (method === "Input.dispatchMouseEvent") this.onInput?.(params.type)
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }
      if (method === "Runtime.callFunctionOn") return { result: { value: this.fileInput && String(params.functionDeclaration).includes('control.type === "file"') ? true : null } }
      if (method === "Page.getNavigationHistory") return { currentIndex: 1, entries: [{ title: "First" }, { title: "Second" }] }
      return {}
    } }, input.operation as PageOperation) as T
  }
}

const firstRef = (snapshot: unknown) => /\[(b\d+e\d+)\]/.exec(String(snapshot))![1]

test("preview operations use the shared outline/actions without a CodeNomad input mark, and release their exact lease", async () => {
  const native = new Native(), page = new BrowserPage(native)
  const first = await page.execute("session", { action: "snapshot" })
  assert.match(String(first.snapshot), /- button "Save" \[b\d+e1\]/)
  const ref = firstRef(first.snapshot)
  assert.deepEqual(await page.execute("session", { action: "click", ref }), { url: "https://example.test/" })
  const functions = native.protocol.filter(call => call.method === "Runtime.callFunctionOn")
  assert.ok(functions.length > 0)
  assert.ok(functions.every(call => !String(call.params.functionDeclaration).includes("__codenomadAutomation")),
    "a user's web page never receives the app's input provenance variables")
  assert.equal(native.leases.size, 0)
  assert.ok(native.calls.filter(call => call.method === "browser.page.send").every(call =>
    call.input.operation && !Object.hasOwn(call.input, "method") && !Object.hasOwn(call.input, "params")
      && !JSON.stringify(call.input).includes("functionDeclaration")), "the private wire carries IDs/JSON operations, never program source")
  const starts = native.calls.filter(call => call.method === "browser.page.begin")
  assert.equal(starts.length, 2)
  assert.notEqual(starts[0].input.operationID, starts[1].input.operationID)
  assert.deepEqual(native.calls.filter(call => call.method === "browser.page.end").map(call => call.input.operationID), starts.map(call => call.input.operationID))
})

test("a click the page received before it moved on is delivered; a page that moved before the press still fails", async () => {
  const native = new Native(), page = new BrowserPage(native)
  native.quads = [[10, 10, 30, 10, 30, 30, 10, 30]]
  let ref = firstRef((await page.execute("a", { action: "snapshot" })).snapshot)
  native.onInput = type => { if (type === "mouseReleased") native.generation = "run/guest/document-2" }
  assert.deepEqual(await page.execute("a", { action: "click", ref }), { url: "https://example.test/", pageChanged: true })
  ref = firstRef((await page.execute("a", { action: "snapshot" })).snapshot)
  native.onInput = type => { if (type === "mouseMoved") native.generation = "run/guest/document-3" }
  await assert.rejects(page.execute("a", { action: "click", ref }), /document changed/)
  assert.equal(native.leases.size, 0)
})

test("scoped snapshots preserve refs and a new document or another session cannot reuse them", async () => {
  const native = new Native(), page = new BrowserPage(native)
  const ref = firstRef((await page.execute("a", { action: "snapshot" })).snapshot)
  const otherBackend = new BrowserPage(new Native())
  await otherBackend.execute("a", { action: "snapshot" })
  await assert.rejects(otherBackend.execute("a", { action: "click", ref }), /stale ref/)
  assert.match(String((await page.execute("a", { action: "snapshot", ref })).snapshot), new RegExp(`\\[${ref}\\]`))
  await page.execute("b", { action: "snapshot" })
  await assert.rejects(page.execute("b", { action: "click", ref }), /stale ref/)
  assert.equal(firstRef((await page.execute("a", { action: "snapshot" })).snapshot), ref)
  native.generation = "run/guest/document-2"
  await assert.rejects(page.execute("a", { action: "click", ref }), /stale ref/)
  const next = firstRef((await page.execute("a", { action: "snapshot" })).snapshot)
  assert.notEqual(next, ref)
  assert.equal(native.leases.size, 0)
})

test("navigation during a native read cannot publish refs, and hidden previews refuse without a fallback", async () => {
  const native = new Native(), page = new BrowserPage(native)
  native.gate = async () => { native.generation = "changed" }
  await assert.rejects(page.execute("a", { action: "snapshot" }), /document changed/)
  assert.equal(native.leases.size, 0)
  native.hidden = true
  await assert.rejects(page.execute("a", { action: "snapshot" }), /No visible browser/)
  assert.ok(native.calls.every(call => call.method.startsWith("browser.page.")))
})

test("queued cancellation and shutdown perform no later input; aborted in-flight reads are fenced and cleaned up", async () => {
  const native = new Native(), page = new BrowserPage(native)
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  native.gate = async () => { entered(); await new Promise<void>(resolve => { release = resolve }) }
  const abort = new AbortController()
  const first = page.execute("a", { action: "snapshot" }, abort.signal)
  await started
  const queuedAbort = new AbortController()
  const queued = page.execute("a", { action: "press", key: "Enter" }, queuedAbort.signal)
  queuedAbort.abort()
  abort.abort()
  release()
  await assert.rejects(first, /abort/i)
  await assert.rejects(queued, /abort/i)
  assert.equal(native.calls.filter(call => call.method === "browser.page.begin").length, 1)
  assert.equal(native.calls.filter(call => call.method === "browser.page.end").length, 1)
  assert.equal(native.leases.size, 0)
  page.close()
  await assert.rejects(page.execute("a", { action: "snapshot" }), /shutting down/)
})

test("an expired queued command cannot delay the next command with cleanup for a lease it never started", async t => {
  const native = new Native(), page = new BrowserPage(native)
  const now = Date.now()
  t.mock.timers.enable({ apis: ["Date"], now })
  let entered!: () => void, release!: () => void, releaseStrayEnd!: () => void
  const enteredRead = new Promise<void>(resolve => { entered = resolve })
  const blockedRead = new Promise<void>(resolve => { release = resolve })
  const blockedEnd = new Promise<void>(resolve => { releaseStrayEnd = resolve })
  native.gate = async () => { entered(); await blockedRead }
  const request = native.request
  t.mock.method(native, "request", (...args: Parameters<typeof request>) => {
    if (args[0] === "browser.page.end" && !native.leases.has(args[1].operationID)) return blockedEnd
    return request(...args)
  })
  const first = page.execute("a", { action: "snapshot" })
  await enteredRead
  const expired = assert.rejects(page.execute("a", { action: "snapshot" }, undefined, undefined, now + 1_000), /timed out/)
  const next = page.execute("a", { action: "snapshot" })
  t.mock.timers.tick(1_000)
  release()
  await first
  try {
    const result = await Promise.race([next, new Promise<void>(resolve => setImmediate(resolve))])
    assert.ok(result, "a command that never sent begin must not block the next command with cleanup")
    assert.match(String(result.snapshot), /Save/)
  } finally {
    releaseStrayEnd()
    await Promise.all([expired, next])
  }
})

test("a lost begin reply still cleans up the exact lease before the next command", async () => {
  const native = new Native(), page = new BrowserPage(native)
  native.loseBeginReply = true
  await assert.rejects(page.execute("a", { action: "snapshot" }), /Begin reply lost/)
  assert.deepEqual(native.calls.map(call => call.method), ["browser.page.begin", "browser.page.end"])
  assert.equal(native.calls[1].input.operationID, native.calls[0].input.operationID)
  assert.equal(native.leases.size, 0)
  native.loseBeginReply = false
  assert.match(String((await page.execute("a", { action: "snapshot" })).snapshot), /Save/)
})

test("a failed native mutation is never replayed, and queue admission is bounded", async () => {
  const native = new Native(), page = new BrowserPage(native)
  const ref = firstRef((await page.execute("a", { action: "snapshot" })).snapshot)
  native.failMethod = "Runtime.callFunctionOn"
  await assert.rejects(page.execute("a", { action: "click", ref }), /reply uncertain/)
  assert.equal(native.protocol.filter(call => call.method === "Runtime.callFunctionOn").length, 1)
  assert.equal(native.leases.size, 0)
  native.failMethod = undefined
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  native.gate = async () => { entered(); await new Promise<void>(resolve => { release = resolve }) }
  const first = page.execute("a", { action: "snapshot" }).catch(error => error)
  await started
  const pending = Array.from({ length: 31 }, () => page.execute("a", { action: "snapshot" }).catch(error => error))
  await assert.rejects(page.execute("a", { action: "snapshot" }), /Too many pending/)
  page.close()
  release()
  assert.ok((await Promise.all([first, ...pending])).every(result => result instanceof Error))
  assert.equal(native.leases.size, 0)
})

test("a failed native scroll seals its lease and preserves the original failure before any mutation", async () => {
  const native = new Native(), page = new BrowserPage(native)
  const ref = firstRef((await page.execute("a", { action: "snapshot" })).snapshot)
  native.failMethod = "DOM.scrollIntoViewIfNeeded"
  await assert.rejects(page.execute("a", { action: "type", ref, text: "unsent", clear: true }), /reply uncertain/)
  assert.equal(native.protocol.filter(call => call.method === "Runtime.callFunctionOn").length, 0)
  assert.equal(native.leases.size, 0)
})

test("fixed-prefix refs are never issued twice, even after a session's table is evicted", async () => {
  const native = new Native(), page = new BrowserPage(native, "e")
  const ref = /\[(e\d+)\]/.exec(String((await page.execute("a", { action: "snapshot" })).snapshot))![1]
  assert.equal(ref, "e1")
  for (let session = 0; session < 128; session++) await page.execute(`other-${session}`, { action: "snapshot" })
  const reissued = /\[(e\d+)\]/.exec(String((await page.execute("a", { action: "snapshot" })).snapshot))![1]
  assert.notEqual(reissued, ref, "the recreated table continues the shared sequence")
  await assert.rejects(page.execute("a", { action: "click", ref }), /stale ref/)
})

test("location also reports the document's title and history, and agent clicks refuse file inputs", async () => {
  const native = new Native(), page = new BrowserPage(native)
  assert.deepEqual(await page.execute("a", { action: "location" }), { title: "Second", canGoBack: true, canGoForward: false, url: "https://example.test/" })
  const ref = firstRef((await page.execute("a", { action: "snapshot" })).snapshot)
  native.fileInput = true
  await assert.rejects(page.execute("a", { action: "click", ref, noFilePicker: true }), /native file picker/)
  assert.equal(native.protocol.some(call => call.method === "Input.dispatchMouseEvent"), false)
})