import assert from "node:assert/strict"
import test from "node:test"
import { checkState, keyRefusal, matchesURL, PreviewTab, type PreviewHost } from "./commands"

function fixture() {
  const calls: Record<string, unknown>[] = []
  const state = { target: undefined as string | undefined, document: 0, checked: false, locked: false, loading: 0, locationFailures: 0, locationReads: 0,
    shot: "iVBORw0KGgo=", url: "http://127.0.0.1/page", onPage: undefined as undefined | ((action: string) => void),
    events: [] as { method: string; params: Record<string, unknown> }[], epoch: "buffer:0", diagnosticsUnavailable: false }
  const host: PreviewHost = {
    probe: async () => {
      if (!state.target) return undefined
      return { target: state.target, loading: state.loading > 0 && state.loading-- > 0 }
    },
    open: async url => { state.target = `doc-${++state.document}`; state.url = url; return { url } },
    navigate: async url => { state.target = `doc-${++state.document}`; state.url = url; return { url } },
    back: async () => { state.target = `doc-${++state.document}`; state.url = "http://127.0.0.1/page"; return { url: state.url } },
    forward: async () => { state.target = `doc-${++state.document}`; state.url = "http://127.0.0.1/next"; return { url: state.url } },
    reload: async () => { state.target = `doc-${++state.document}`; return { url: state.url } },
    screenshot: async () => ({ image: { mime: "image/png", data: state.shot } }),
    page: async (action, at) => {
      // Address reads follow every command; the tests look at what acted on the page.
      if (action.action !== "location") calls.push({ ...action, at })
      state.onPage?.(action.action)
      if (action.action === "diagnostics") {
        if (state.diagnosticsUnavailable) throw new Error("Browser diagnostics are unavailable in WebKit previews")
        const events = state.events.slice(action.after)
        return { epoch: state.epoch, events, next: state.events.length, lost: { messages: 0, requests: 0 }, more: false, contexts: [], lostRequests: [] }
      }
      if (action.action === "response-body") return { body: `body of ${action.request}`, base64Encoded: false }
      if (action.action === "location") {
        state.locationReads++
        if (state.locationFailures-- > 0) throw new Error("Native request timed out: browser.page.begin")
        return { url: state.url, title: "Fixture page", canGoBack: state.document > 1, canGoForward: false }
      }
      if (action.action === "snapshot") {
        if (action.ref === "e2") return { url: "", snapshot: `- checkbox "Keep this checked" [e2] ${state.checked ? "checked" : "unchecked"}`, collapsed: false }
        if (action.ref === "e3") return { url: "", snapshot: '- radio "Pro" [e3] checked', collapsed: false }
        return { url: "", snapshot: '- button "Go" [e1]', collapsed: false }
      }
      if (action.action === "click" && action.ref === "e2") { if (!state.locked) state.checked = !state.checked; return { url: "" } }
      if (action.action === "click" && action.ref === "e7") { state.target = `doc-${++state.document}`; state.url = "http://127.0.0.1/next"; return { url: "", pageChanged: true } }
      if (action.action === "wait") throw new Error('"Saved" did not appear within 0 ms')
      if (action.action === "click" && action.ref === "e9") throw new Error("Unknown or stale ref e9; take a new snapshot")
      return { url: "" }
    },
  }
  return { tab: new PreviewTab(host), calls, state }
}
const signal = new AbortController().signal

test("one preview tab: absent until opened, then a stable ID whose generation follows the document", async () => {
  const { tab, calls } = fixture()
  assert.deepEqual((await tab.run({ type: "tabs.list" }, undefined, signal)), { type: "success", result: { value: { tabs: [], focusedTabID: null }, files: [] } })
  const opened = await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal) as any
  assert.equal(opened.result.value.id, tab.id)
  assert.match(tab.id, /^tab_[a-f0-9-]{36}$/)
  const generation = opened.result.value.generation
  const clicked = await tab.run({ type: "click", tabID: tab.id, ref: "@e1" }, generation, signal) as any
  assert.equal(clicked.type, "success")
  assert.deepEqual(calls.at(-1), { action: "click", ref: "e1", noFilePicker: true, at: "doc-1" })
  await tab.run({ type: "navigate", tabID: tab.id, url: "http://127.0.0.1/next" }, generation, signal)
  assert.equal((await tab.run({ type: "hover", tabID: tab.id, ref: "e1" }, generation, signal) as any).code, "document_changed",
    "a command selected for the previous document is refused")
})

test("a click that follows a link succeeds and reports the document it led to", async () => {
  const { tab } = fixture()
  const opened = await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal) as any
  const clicked = await tab.run({ type: "click", tabID: tab.id, ref: "e7" }, opened.result.value.generation, signal) as any
  assert.equal(clicked.type, "success")
  assert.equal(clicked.result.value.url, "http://127.0.0.1/next")
  assert.equal(clicked.result.value.generation, opened.result.value.generation + 1)
})

test("every step of one command stays on the document it started on", async () => {
  const { tab, calls, state } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  // A concurrent command refreshes the tab onto another document between the two fill steps.
  state.onPage = action => { if (action !== "type") return; state.onPage = undefined; state.target = `doc-${++state.document}`; void tab.run({ type: "tabs.list" }, undefined, signal) }
  calls.length = 0
  await tab.run({ type: "fill_form", tabID: tab.id, fields: [{ type: "text", ref: "e1", value: "a" }, { type: "text", ref: "e4", value: "b" }] }, undefined, signal)
  assert.deepEqual(calls.filter(call => call.action === "type").map(call => call.at), ["doc-1", "doc-1"])
})

test("snapshots, failures and the operations the CodeNomad preview does not offer", async () => {
  const { tab } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  const snap = await tab.run({ type: "snapshot", tabID: tab.id }, undefined, signal) as any
  assert.equal(snap.result.value.content, '- button "Go" [e1]')
  assert.equal((await tab.run({ type: "click", tabID: tab.id, ref: "e9" }, undefined, signal) as any).code, "stale_ref")
  assert.equal((await tab.run({ type: "wait", tabID: tab.id, condition: "text", text: "Saved", timeoutMs: 1 }, undefined, signal) as any).code, "condition_unmet")
  for (const type of ["evaluate", "trace.start", "lighthouse"])
    assert.equal((await tab.run({ type, tabID: tab.id, script: "1" }, undefined, signal) as any).code, "unsupported", type)
  const shot = await tab.run({ type: "screenshot", tabID: tab.id }, undefined, signal) as any
  assert.equal(shot.result.files[0].mime, "image/png")
  assert.match(shot.result.files[0].id, /^file_[a-f0-9-]{36}$/)
  assert.equal((await tab.run({ type: "tabs.open", url: "file:///etc/passwd" }, undefined, signal) as any).code, "unsupported")
})

test("wait for load follows the native loading state, and the tab reports it", async () => {
  const { tab, state } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  state.loading = 3
  assert.equal((await tab.run({ type: "tabs.list" }, undefined, signal) as any).result.value.tabs[0].loading, true)
  const waited = await tab.run({ type: "wait", tabID: tab.id, condition: "load", timeoutMs: 5_000 }, undefined, signal) as any
  assert.equal(waited.type, "success")
  assert.equal(waited.result.value.loading, false)
  assert.equal(state.loading, 0, "waited until the host stopped reporting a load")
  state.loading = 1_000
  assert.equal((await tab.run({ type: "wait", tabID: tab.id, condition: "load", timeoutMs: 150 }, undefined, signal) as any).code, "condition_unmet")
})

test("press refuses clipboard and context-menu shortcuts before any input", async () => {
  const { tab, calls } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  calls.length = 0
  for (const key of ["Control+C", "Meta+v", "Control+X", "Shift+Insert", "Control+Insert", "Shift+Delete", "Shift+F10", "ContextMenu"])
    assert.equal((await tab.run({ type: "press", tabID: tab.id, key }, undefined, signal) as any).code, "operation_failed", key)
  assert.equal(calls.length, 0)
  for (const key of ["Enter", "Control+A", "Shift+Tab", "c", "Delete"]) assert.equal(keyRefusal(key), undefined, key)
})

test("back, forward, reload, check by state attribute, select by value and fill_form", async () => {
  const { tab, calls } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  const back = await tab.run({ type: "back", tabID: tab.id }, undefined, signal) as any
  assert.equal(back.type, "success")
  assert.equal(back.result.value.url, "http://127.0.0.1/page")
  const forward = await tab.run({ type: "forward", tabID: tab.id }, undefined, signal) as any
  assert.equal(forward.result.value.url, "http://127.0.0.1/next")
  const reload = await tab.run({ type: "reload", tabID: tab.id }, undefined, signal) as any
  assert.equal(reload.type, "success")
  calls.length = 0
  // "Keep this checked" is the label: the control is unchecked and is clicked once.
  assert.equal((await tab.run({ type: "check", tabID: tab.id, ref: "e2", checked: true }, undefined, signal)).type, "success")
  assert.equal(calls.filter(c => c.action === "click").length, 1)
  assert.equal((await tab.run({ type: "check", tabID: tab.id, ref: "e2", checked: true }, undefined, signal)).type, "success")
  assert.equal(calls.filter(c => c.action === "click").length, 1)
  assert.equal((await tab.run({ type: "check", tabID: tab.id, ref: "e1", checked: true }, undefined, signal) as any).code, "operation_failed")
  assert.equal((await tab.run({ type: "check", tabID: tab.id, ref: "e3", checked: false }, undefined, signal) as any).code, "operation_failed")
  calls.length = 0
  await tab.run({ type: "select", tabID: tab.id, ref: "e5", values: ["pro"] }, undefined, signal)
  assert.equal(calls[0].byValue, true, "OpenCode selects options by value")
  calls.length = 0
  const filled = await tab.run({
    type: "fill_form", tabID: tab.id,
    fields: [
      { ref: "e4", type: "text", value: "Ada" },
      { ref: "e5", type: "select", values: ["pro"] },
      { ref: "e2", type: "check", checked: false },
    ],
  }, undefined, signal)
  assert.equal(filled.type, "success")
  assert.deepEqual(calls.map(c => c.action), ["type", "select", "snapshot", "checked", "click", "snapshot", "checked"])
  assert.equal(calls[1].byValue, true)
})

test("check fails when the page keeps the previous state", async () => {
  const { tab, state } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  state.locked = true
  const outcome = await tab.run({ type: "check", tabID: tab.id, ref: "e2", checked: true }, undefined, signal) as any
  assert.equal(outcome.code, "operation_failed")
  assert.match(outcome.message, /did not stay checked/)
})

test("options the preview cannot honor are refused, defaults are accepted, and maxLines bounds the snapshot", async () => {
  const { tab, calls } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  calls.length = 0
  for (const [action, option] of [
    [{ type: "snapshot", interactive: true }, "interactive"], [{ type: "snapshot", frameID: "f1" }, "frameID"], [{ type: "snapshot", depth: 2 }, "depth"],
    [{ type: "find", text: "Go", interactive: true }, "interactive"], [{ type: "reload", ignoreCache: true }, "ignoreCache"],
    [{ type: "click", ref: "e1", button: "right" }, "button"], [{ type: "click", ref: "e1", count: 2 }, "count"],
    [{ type: "click", ref: "e1", modifiers: ["Shift"] }, "modifiers"], [{ type: "screenshot", fullPage: true }, "fullPage"],
    [{ type: "screenshot", format: "jpeg" }, "format"], [{ type: "wait", condition: "text", text: "x", frameID: "f1" }, "frameID"],
  ] as const) {
    const outcome = await tab.run({ ...action, tabID: tab.id }, undefined, signal) as any
    assert.equal(outcome.code, "unsupported", `${action.type} ${option}`)
    assert.match(outcome.message, new RegExp(`with ${option}`))
  }
  assert.equal((await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page", focus: false }, undefined, signal) as any).code, "unsupported")
  assert.equal(calls.length, 0, "nothing reached the page")
  assert.equal((await tab.run({ type: "click", tabID: tab.id, ref: "e1", button: "left", count: 1, modifiers: [] }, undefined, signal)).type, "success")
  assert.equal((await tab.run({ type: "reload", tabID: tab.id, ignoreCache: false }, undefined, signal)).type, "success")
  const lines = await tab.run({ type: "snapshot", tabID: tab.id, maxLines: 1 }, undefined, signal) as any
  assert.equal(lines.result.value.content.split("\n").length, 1)
})

test("an oversized screenshot fails instead of producing a result OpenCode refuses", async () => {
  const { tab, state } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  state.shot = "A".repeat(Math.ceil((5 * 1024 * 1024 + 1) * 4 / 3))
  assert.equal((await tab.run({ type: "screenshot", tabID: tab.id }, undefined, signal) as any).code, "operation_failed")
})

test("a failed address read is retried, and page results keep the address current", async () => {
  const { tab, state } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/start" }, undefined, signal)
  // The person navigates; the first read of the new document's address fails.
  state.target = "doc-99"
  state.url = "http://127.0.0.1/page"
  state.locationFailures = 1
  const stale = await tab.run({ type: "tabs.list" }, undefined, signal) as any
  assert.equal(stale.result.value.tabs[0].url, "http://127.0.0.1/start")
  const listed = await tab.run({ type: "tabs.list" }, undefined, signal) as any
  assert.equal(listed.result.value.tabs[0].url, "http://127.0.0.1/page", "the read is retried for the same document")
})

test("checked state comes from the attributes after the ref only", () => {
  assert.equal(checkState('- checkbox "Keep this checked by default" [e5] unchecked', "e5"), "unchecked")
  assert.equal(checkState('- checkbox "Terms" [e5] checked', "e5"), "checked")
  assert.equal(checkState('- checkbox "Terms" [e5] value="checked"', "e5"), undefined)
  assert.equal(checkState('- checkbox "Mixed" [e5] checked=mixed', "e5"), "checked=mixed")
  assert.equal(checkState('- button "checked" [e1]', "e1"), undefined)
  assert.equal(checkState('- checkbox "Billing [e5] checked by Finance" [e5] unchecked', "e5"), "unchecked", "a name quoting the ref and a state never counts")
})

test("commands run one at a time, so two concurrent checks set the box once", async () => {
  const { tab, calls, state } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  calls.length = 0
  const outcomes = await Promise.all([1, 2].map(() => tab.run({ type: "check", tabID: tab.id, ref: "e2", checked: true }, undefined, signal)))
  assert.deepEqual(outcomes.map(outcome => outcome.type), ["success", "success"])
  assert.equal(calls.filter(call => call.action === "click").length, 1)
  assert.equal(state.checked, true)
})

test("the tab reports the document's title and history", async () => {
  const { tab } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  await tab.run({ type: "navigate", tabID: tab.id, url: "http://127.0.0.1/next" }, undefined, signal)
  const [listed] = (await tab.run({ type: "tabs.list" }, undefined, signal) as any).result.value.tabs
  assert.deepEqual([listed.title, listed.canGoBack, listed.canGoForward], ["Fixture page", true, false])
})

test("tabs.list reads the address, title and history again, and text waits match the visible body literally", async () => {
  const { tab, calls, state } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  const listed = async () => (await tab.run({ type: "tabs.list" }, undefined, signal) as any).result.value.tabs[0]
  const before = state.locationReads
  assert.equal((await listed()).title, "Fixture page")
  assert.equal((await listed()).title, "Fixture page")
  assert.equal(state.locationReads - before, 2, "each list reads the document's metadata")
  calls.length = 0
  await tab.run({ type: "wait", tabID: tab.id, condition: "text", text: "Saved", timeoutMs: 1 }, undefined, signal)
  assert.equal(calls[0].literal, true)
})
test("a cancelled pause releases the queue, and check fails when the control is no longer a checkbox", async () => {
  let checked = true
  const tab = new PreviewTab({
    probe: async () => ({ target: "doc", loading: false }),
    page: async (action: { action: string }) => {
      if (action.action === "snapshot") return { url: "", snapshot: checked ? '- checkbox "Remember" [e1] checked' : '- button "Remember" [e1]' }
      if (action.action === "click") checked = false
      return { url: "" }
    },
  } as unknown as PreviewHost)
  const tabID = tab.id
  const replaced = await tab.run({ type: "check", tabID, ref: "e1", checked: false }, undefined, signal) as any
  assert.equal(replaced.type, "failure", "a control that became a button is not unchecked")
  const cancel = new AbortController()
  const started = Date.now()
  const paused = tab.run({ type: "wait", tabID, condition: "delay", timeoutMs: 5_000 }, undefined, cancel.signal)
  setTimeout(() => cancel.abort(), 30)
  assert.equal((await tab.run({ type: "snapshot", tabID }, undefined, signal)).type, "success")
  assert.ok(Date.now() - started < 2_000, "the next command runs once the pause is cancelled")
  assert.equal((await paused).type, "failure")
})
test("a navigation whose preview disappears fails, snapshots render within maxChars, and a diagonal scroll is one gesture", async () => {
  const { tab, calls, state } = fixture()
  const opened = await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal) as any
  await tab.run({ type: "snapshot", tabID: tab.id, maxChars: 90_000 }, undefined, signal)
  assert.equal((calls.at(-1) as any).budget, 90_000)
  await tab.run({ type: "scroll", tabID: tab.id, deltaX: 50, deltaY: 100 }, undefined, signal)
  assert.deepEqual(calls.filter(call => call.action === "scroll").map(call => call.delta), [{ x: 50, y: 100 }])
  // The preview is hidden right after the native load receipt.
  const host = (tab as any).host as PreviewHost
  const navigate = host.navigate
  host.navigate = async (...args) => { const loaded = await navigate(...args); state.target = undefined; return loaded }
  const outcome = await tab.run({ type: "navigate", tabID: tab.id, url: "http://127.0.0.1/next" }, opened.result.value.generation, signal) as any
  assert.equal(outcome.type, "failure")
  assert.deepEqual((await tab.run({ type: "tabs.list" }, undefined, signal) as any).result.value.tabs, [])
})
test("a load ending in another preview fails, an older probe never overwrites a newer one, wait ignores the document and check reads the native property", async () => {
  const { tab, calls, state } = fixture()
  const host = (tab as any).host as PreviewHost
  const probe = host.probe
  let registration = "window-a"
  host.probe = async (...args) => { const probed = await probe(...args); return probed && { ...probed, registration } }
  const open = host.open
  host.open = async (...args) => ({ ...await open(...args), registration: "window-a" })
  const navigate = host.navigate
  host.navigate = async (...args) => { const loaded = await navigate(...args); registration = "window-b"; return { ...loaded, registration: "window-a" } }
  const opened = await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal) as any
  const moved = await tab.run({ type: "navigate", tabID: tab.id, url: "http://127.0.0.1/next" }, opened.result.value.generation, signal) as any
  assert.equal(moved.type, "failure", "the load's receipt belongs to the replaced preview")
  host.navigate = navigate

  // An older probe that answers last does not bring back its document.
  let release!: () => void
  host.probe = async (...args) => {
    const probed = await probe(...args)
    if (probed?.target === "doc-2") await new Promise<void>(resolve => { release = resolve })
    return probed
  }
  const older = tab.run({ type: "tabs.list" }, undefined, signal)
  await new Promise(resolve => setImmediate(resolve))
  state.target = "doc-9"
  const newer = await tab.run({ type: "tabs.list" }, undefined, signal) as any
  release()
  await older
  assert.equal(newer.result.value.tabs[0].generation, (await tab.run({ type: "tabs.list" }, undefined, signal) as any).result.value.tabs[0].generation)
  host.probe = probe

  const current = (await tab.run({ type: "tabs.list" }, undefined, signal) as any).result.value.tabs[0].generation
  state.target = `doc-${++state.document}`
  assert.equal((await tab.run({ type: "wait", tabID: tab.id, condition: "load" }, current, signal)).type, "success", "a wait reads whichever document is current")

  // A mixed checkbox whose native property is checked is unchecked by a click.
  let checked = true
  const page = host.page
  host.page = async (action, at, deadline, abort) => {
    if (action.action === "snapshot" && action.ref === "e7") return { url: "", snapshot: `- checkbox "Mixed" [e7] ${checked ? "checked=mixed" : "unchecked"}` }
    if (action.action === "checked") return { url: "", checked }
    if (action.action === "click" && action.ref === "e7") { checked = false; return { url: "" } }
    return page(action, at, deadline, abort)
  }
  assert.equal((await tab.run({ type: "check", tabID: tab.id, ref: "e7", checked: false }, undefined, signal)).type, "success")
  assert.equal(checked, false, "the click happened")
  assert.ok(calls)
})
test("an open that ends in another preview fails, and a text wait follows the tab to its next document", async () => {
  const { tab, state } = fixture()
  const host = (tab as any).host as PreviewHost
  const probe = host.probe, open = host.open, page = host.page
  host.probe = async (...args) => { const probed = await probe(...args); return probed && { ...probed, registration: "window-b" } }
  host.open = async (...args) => ({ ...await open(...args), registration: "window-a" })
  assert.equal((await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)).type, "failure")
  host.probe = probe
  host.open = open
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  // The first document navigates away during the wait; the next one shows the text.
  host.page = async (action, at, deadline, abort) => {
    if (action.action !== "wait") return page(action, at, deadline, abort)
    if (at === "doc-2") { state.target = "doc-3"; throw new Error("Browser target is stale; probe again") }
    return { url: "http://127.0.0.1/saved" }
  }
  const waited = await tab.run({ type: "wait", tabID: tab.id, condition: "text", text: "Saved", timeoutMs: 2_000 }, undefined, signal) as any
  assert.equal(waited.type, "success")
})
test("each web open gives a new tab ID, a replaced preview too, and the address read from the preview wins over a receipt", async () => {
  const { tab, state } = fixture()
  const host = (tab as any).host as PreviewHost
  const probe = host.probe, open = host.open
  let registration = "window-a"
  host.probe = async (...args) => { const probed = await probe(...args); return probed && { ...probed, registration } }
  host.open = async (...args) => ({ ...await open(...args), registration })
  const first = (await tab.run({ type: "tabs.open", url: "http://127.0.0.1/a" }, undefined, signal) as any).result.value.id
  const second = (await tab.run({ type: "tabs.open", url: "http://127.0.0.1/b" }, undefined, signal) as any).result.value.id
  assert.notEqual(first, second)
  assert.equal((await tab.run({ type: "snapshot", tabID: first }, undefined, signal) as any).code, "operation_failed", "the older ID is gone")
  registration = "window-b"
  const listed = (await tab.run({ type: "tabs.list" }, undefined, signal) as any).result.value
  assert.notEqual(listed.focusedTabID, second, "another registration is another tab")
  // Another document committed before the follow-up probe: the tab reports the address it reads.
  const navigate = host.navigate
  host.navigate = async (...args) => { const loaded = await navigate(...args); state.url = "http://127.0.0.1/intervening"; return { ...loaded, registration } }
  const current = (await tab.run({ type: "tabs.list" }, undefined, signal) as any).result.value.tabs[0]
  const moved = await tab.run({ type: "navigate", tabID: current.id, url: "http://127.0.0.1/requested" }, current.generation, signal) as any
  assert.equal(moved.result.value.url, "http://127.0.0.1/intervening")
})

test("a preview that comes back as another registration is another tab, commands conclude before the next runs, and URL waits match", async () => {
  const { tab, state } = fixture()
  const host = (tab as any).host as PreviewHost
  const probe = host.probe, open = host.open
  let registration = "window-a"
  host.probe = async (...args) => { const probed = await probe(...args); return probed && { ...probed, registration } }
  host.open = async (...args) => ({ ...await open(...args), registration })
  const opened = (await tab.run({ type: "tabs.open", url: "http://127.0.0.1/a" }, undefined, signal) as any).result.value
  // Preview A goes away, then B shows: A's ID never reaches B.
  const shown = state.target
  state.target = undefined
  await tab.run({ type: "tabs.list" }, undefined, signal)
  state.target = shown
  registration = "window-b"
  assert.equal((await tab.run({ type: "navigate", tabID: opened.id, url: "http://127.0.0.1/b" }, undefined, signal) as any).code, "operation_failed")

  // The next command waits for the previous one's conclusion (its inventory publication).
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let opens = 0
  const counting = host.open
  host.open = async (...args) => { opens++; return counting(...args) }
  const first = tab.run({ type: "tabs.open", url: "http://127.0.0.1/c" }, undefined, signal, undefined, async outcome => { await held; return outcome })
  const second = tab.run({ type: "tabs.open", url: "http://127.0.0.1/d" }, undefined, signal)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(opens, 1, "the second open waits for the first to conclude")
  release()
  await Promise.all([first, second])
  assert.equal(opens, 2)

  // A same-document route change satisfies a glob URL wait.
  const current = (await tab.run({ type: "tabs.list" }, undefined, signal) as any).result.value.tabs[0]
  setTimeout(() => { state.url = "http://127.0.0.1/app/dashboard" }, 150)
  const waited = await tab.run({ type: "wait", tabID: current.id, condition: "url", url: "**/dashboard", timeoutMs: 2_000 }, undefined, signal) as any
  assert.equal(waited.type, "success")
  assert.equal(matchesURL("https://app.test/dashboard?tab=1", "/dashboard"), true)
  assert.equal(matchesURL("https://app.test/dashboard/settings", "**/dashboard"), false)
})

test("console and network read the host's events for the current document; WebKit answers unsupported", async () => {
  const { tab, state } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  state.events.push(
    { method: "Runtime.consoleAPICalled", params: { type: "error", timestamp: 1, args: [{ type: "string", value: "boom" }] } },
    { method: "Network.requestWillBeSent", params: { requestId: "r1", timestamp: 1, wallTime: 1, type: "XHR", request: { url: "http://127.0.0.1/api", method: "GET", headers: {} } } },
    { method: "Network.responseReceived", params: { requestId: "r1", hasExtraInfo: false, response: { status: 500, mimeType: "text/plain", headers: {} } } },
    { method: "Network.loadingFinished", params: { requestId: "r1", timestamp: 2 } },
  )
  const logged = await tab.run({ type: "console", tabID: tab.id, level: "error" }, undefined, signal) as any
  assert.deepEqual(logged.result.value.messages.map((entry: any) => entry.text), ["boom"])
  assert.equal(logged.result.value.tab.id, tab.id)
  const listed = await tab.run({ type: "network.list", tabID: tab.id, urlContains: "/api" }, undefined, signal) as any
  assert.deepEqual(listed.result.value.requests.map((item: any) => [item.statusCode, item.state]), [[500, "completed"]])
  const got = await tab.run({ type: "network.get", tabID: tab.id, id: listed.result.value.requests[0].id, includeResponseBody: true }, undefined, signal) as any
  assert.deepEqual(got.result.value.responseBody, { state: "text", text: "body of r1", truncated: false })
  assert.equal((await tab.run({ type: "network.get", tabID: tab.id, id: "missing" }, undefined, signal) as any).code, "operation_failed")
  // A new document: the host clears its buffer and the readout restarts.
  state.events.length = 0
  state.epoch = "buffer:1"
  assert.deepEqual((await tab.run({ type: "console", tabID: tab.id }, undefined, signal) as any).result.value.messages, [])
  state.diagnosticsUnavailable = true
  assert.equal((await tab.run({ type: "console", tabID: tab.id }, undefined, signal) as any).code, "unsupported")
  assert.equal((await tab.run({ type: "console", tabID: tab.id, frameID: "f" }, undefined, signal) as any).code, "unsupported")
})

test("a new tab starts with empty readouts, and a body read on a lease the page replaced is document_changed", async () => {
  const { tab, state } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  state.events.push(
    { method: "Network.requestWillBeSent", params: { requestId: "r1", timestamp: 1, wallTime: 1, type: "XHR", request: { url: "http://127.0.0.1/api", method: "GET", headers: {} } } },
    { method: "Network.responseReceived", params: { requestId: "r1", hasExtraInfo: false, response: { status: 200, mimeType: "text/plain", headers: {} } } },
    { method: "Network.loadingFinished", params: { requestId: "r1", timestamp: 2 } },
  )
  const listed = await tab.run({ type: "network.list", tabID: tab.id }, undefined, signal) as any
  const old = listed.result.value.requests[0].id
  const host = (tab as any).host as PreviewHost
  const page = host.page
  host.page = async (action, at, deadline, abort) => {
    if (action.action === "response-body") throw new Error("Browser page lease is no longer current")
    return page(action, at, deadline, abort)
  }
  assert.equal((await tab.run({ type: "network.get", tabID: tab.id, id: old, includeResponseBody: true }, undefined, signal) as any).code, "document_changed")
  host.page = page
  // A fragment-only open keeps the document and its buffer epoch, but it is a new tab.
  const reopened = (await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page#next" }, undefined, signal) as any).result.value
  assert.deepEqual((await tab.run({ type: "network.list", tabID: reopened.id }, undefined, signal) as any).result.value.requests, [])
  assert.equal((await tab.run({ type: "network.get", tabID: reopened.id, id: old }, undefined, signal) as any).code, "operation_failed",
    "the previous tab's request IDs are refused")
})

test("a readout whose tab a concurrent tabs.list replaces fails, and an open leaves the previous tab's unread events behind", async () => {
  const { tab, state } = fixture()
  const host = (tab as any).host as PreviewHost
  const probe = host.probe, open = host.open, page = host.page
  let registration = "window-a"
  host.probe = async (...args) => { const probed = await probe(...args); return probed && { ...probed, registration } }
  host.open = async (...args) => ({ ...await open(...args), registration })
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  state.events.push({ method: "Runtime.consoleAPICalled", params: { type: "warning", timestamp: 1, args: [{ type: "string", value: "before second tab" }] } })
  const reopened = (await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page#next" }, undefined, signal) as any).result.value
  assert.deepEqual((await tab.run({ type: "console", tabID: reopened.id }, undefined, signal) as any).result.value.messages, [])
  host.page = async (action, at, deadline, abort) => {
    const result = await page(action, at, deadline, abort)
    if (action.action === "diagnostics") { registration = "window-b"; await tab.run({ type: "tabs.list" }, undefined, signal) }
    return result
  }
  assert.equal((await tab.run({ type: "console", tabID: reopened.id }, undefined, signal) as any).code, "document_changed")
})

test("an open keeps its new page's startup diagnostics, and a readout during a navigation fails", async () => {
  const { tab, state } = fixture()
  const host = (tab as any).host as PreviewHost
  const open = host.open, page = host.page
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/first" }, undefined, signal)
  state.events.push({ method: "Runtime.consoleAPICalled", params: { type: "warning", timestamp: 1, args: [{ type: "string", value: "first page" }] } })
  // The next open loads a new document, whose startup the host records in a new epoch.
  host.open = async (...args) => {
    const opened = await open(...args)
    state.events.length = 0
    state.epoch = "buffer:7"
    state.events.push({ method: "Runtime.consoleAPICalled", params: { type: "warning", timestamp: 2, args: [{ type: "string", value: "next page startup" }] } })
    return opened
  }
  const next = (await tab.run({ type: "tabs.open", url: "http://127.0.0.1/next" }, undefined, signal) as any).result.value
  assert.deepEqual((await tab.run({ type: "console", tabID: next.id }, undefined, signal) as any).result.value.messages.map((entry: any) => entry.text), ["next page startup"])
  host.page = async (action, at, deadline, abort) => {
    const result = await page(action, at, deadline, abort)
    if (action.action === "diagnostics") { state.target = `doc-${++state.document}`; await tab.run({ type: "tabs.list" }, undefined, signal) }
    return result
  }
  assert.equal((await tab.run({ type: "console", tabID: next.id }, undefined, signal) as any).code, "document_changed")
})