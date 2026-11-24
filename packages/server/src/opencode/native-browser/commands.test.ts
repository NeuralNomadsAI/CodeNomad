import assert from "node:assert/strict"
import test from "node:test"
import { checkState, keyRefusal, PreviewTab, type PreviewHost } from "./commands"

function fixture() {
  const calls: Record<string, unknown>[] = []
  const state = { target: undefined as string | undefined, document: 0, checked: false, locked: false, loading: 0, locationFailures: 0,
    shot: "iVBORw0KGgo=", onPage: undefined as undefined | ((action: string) => void) }
  const host: PreviewHost = {
    probe: async () => {
      if (!state.target) return undefined
      return { target: state.target, loading: state.loading > 0 && state.loading-- > 0 }
    },
    open: async url => { state.target = `doc-${++state.document}`; return { url } },
    navigate: async url => { state.target = `doc-${++state.document}`; return { url } },
    back: async () => { state.target = `doc-${++state.document}`; return { url: "http://127.0.0.1/page" } },
    forward: async () => { state.target = `doc-${++state.document}`; return { url: "http://127.0.0.1/next" } },
    reload: async () => { state.target = `doc-${++state.document}`; return { url: "http://127.0.0.1/next" } },
    screenshot: async () => ({ image: { mime: "image/png", data: state.shot } }),
    page: async (action, at) => {
      // Address reads follow every command; the tests look at what acted on the page.
      if (action.action !== "location") calls.push({ ...action, at })
      state.onPage?.(action.action)
      if (action.action === "location") {
        if (state.locationFailures-- > 0) throw new Error("Native request timed out: browser.page.begin")
        return { url: "http://127.0.0.1/page", title: "Fixture page", canGoBack: state.document > 1, canGoForward: false }
      }
      if (action.action === "snapshot") {
        if (action.ref === "e2") return { url: "", snapshot: `- checkbox "Keep this checked" [e2] ${state.checked ? "checked" : "unchecked"}`, collapsed: false }
        if (action.ref === "e3") return { url: "", snapshot: '- radio "Pro" [e3] checked', collapsed: false }
        return { url: "", snapshot: '- button "Go" [e1]', collapsed: false }
      }
      if (action.action === "click" && action.ref === "e2") { if (!state.locked) state.checked = !state.checked; return { url: "" } }
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

test("every step of one command stays on the document it started on", async () => {
  const { tab, calls, state } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  // A concurrent command refreshes the tab onto another document between the two scroll steps.
  state.onPage = action => { if (action !== "scroll") return; state.onPage = undefined; state.target = `doc-${++state.document}`; void tab.run({ type: "tabs.list" }, undefined, signal) }
  calls.length = 0
  await tab.run({ type: "scroll", tabID: tab.id, deltaY: 100, deltaX: 50 }, undefined, signal)
  assert.deepEqual(calls.filter(call => call.action === "scroll").map(call => call.at), ["doc-1", "doc-1"])
})

test("snapshots, failures and the operations the CodeNomad preview does not offer", async () => {
  const { tab } = fixture()
  await tab.run({ type: "tabs.open", url: "http://127.0.0.1/page" }, undefined, signal)
  const snap = await tab.run({ type: "snapshot", tabID: tab.id }, undefined, signal) as any
  assert.equal(snap.result.value.content, '- button "Go" [e1]')
  assert.equal((await tab.run({ type: "click", tabID: tab.id, ref: "e9" }, undefined, signal) as any).code, "stale_ref")
  assert.equal((await tab.run({ type: "wait", tabID: tab.id, condition: "text", text: "Saved", timeoutMs: 1 }, undefined, signal) as any).code, "condition_unmet")
  for (const type of ["evaluate", "console", "network.list", "lighthouse"])
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
  assert.deepEqual(calls.map(c => c.action), ["type", "select", "snapshot", "click", "snapshot"])
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
    [{ type: "screenshot", format: "jpeg" }, "format"], [{ type: "wait", condition: "url", url: "x" }, "url"],
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