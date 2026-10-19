import assert from "node:assert/strict"
import { test } from "node:test"
import { BrowserPage } from "./browser-page"

class Native {
  generation = "run/guest/document-1"
  hidden = false
  calls: Array<{ method: string; input: Record<string, any> }> = []
  gate?: () => Promise<void>
  leases = new Map<string, string>()
  nodes = [{ nodeId: "one", backendDOMNodeId: 42, role: { value: "button" }, name: { value: "Save" } }]
  request = async <T>(method: string, input: Record<string, any>): Promise<T> => {
    this.calls.push({ method, input })
    if (method === "browser.page.end") { this.leases.delete(input.operationID); return {} as T }
    if (this.hidden) throw new Error("No visible browser")
    if (method === "browser.page.begin") {
      this.leases.set(input.operationID, this.generation)
      return { generation: this.generation, url: "https://example.test/" } as T
    }
    if (input.generation !== this.generation || this.leases.get(input.operationID) !== this.generation) throw new Error("Browser document changed")
    if (method === "browser.page.check") return { url: "https://example.test/" } as T
    if (input.method === "Accessibility.getFullAXTree") { await this.gate?.(); return { nodes: this.nodes } as T }
    if (input.method === "DOM.resolveNode") return { object: { objectId: "object-1" } } as T
    if (input.method === "Runtime.callFunctionOn") return { result: { value: null } } as T
    return {} as T
  }
}

const firstRef = (snapshot: unknown) => /\[(b\d+e\d+)\]/.exec(String(snapshot))![1]

test("preview operations use the shared outline/actions without a CodeNomad input mark, and release their exact lease", async () => {
  const native = new Native(), page = new BrowserPage(native)
  const first = await page.execute("session", { action: "snapshot" })
  assert.match(String(first.snapshot), /- button "Save" \[b1e1\]/)
  const ref = firstRef(first.snapshot)
  assert.deepEqual(await page.execute("session", { action: "click", ref }), { url: "https://example.test/" })
  const functions = native.calls.filter(call => call.input.method === "Runtime.callFunctionOn")
  assert.ok(functions.length > 0)
  assert.ok(functions.every(call => !String(call.input.params.functionDeclaration).includes("__codenomadAutomation")),
    "a user's web page never receives the app's input provenance variables")
  assert.equal(native.leases.size, 0)
  const starts = native.calls.filter(call => call.method === "browser.page.begin")
  assert.equal(starts.length, 2)
  assert.notEqual(starts[0].input.operationID, starts[1].input.operationID)
  assert.deepEqual(native.calls.filter(call => call.method === "browser.page.end").map(call => call.input.operationID), starts.map(call => call.input.operationID))
})

test("scoped snapshots preserve refs and a new document or another session cannot reuse them", async () => {
  const native = new Native(), page = new BrowserPage(native)
  const ref = firstRef((await page.execute("a", { action: "snapshot" })).snapshot)
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
  assert.equal(native.leases.size, 0)
  page.close()
  await assert.rejects(page.execute("a", { action: "snapshot" }), /shutting down/)
})
