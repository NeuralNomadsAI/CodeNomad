import assert from "node:assert/strict"
import test from "node:test"
import { PreviewTab, type PreviewHost } from "./commands"

function fixture() {
  const calls: unknown[] = []
  let target: string | undefined, document = 0, checkboxChecked = false
  const host: PreviewHost = {
    probe: async () => target,
    open: async (_session, url) => { target = `doc-${++document}`; return { url } },
    navigate: async (_session, url) => { target = `doc-${++document}`; return { url } },
    back: async () => { target = `doc-${++document}`; return { url: "http://127.0.0.1/page" } },
    forward: async () => { target = `doc-${++document}`; return { url: "http://127.0.0.1/next" } },
    reload: async () => { target = `doc-${++document}`; return { url: "http://127.0.0.1/next" } },
    screenshot: async () => ({ image: { mime: "image/png", data: "iVBORw0KGgo=" } }),
    page: async (_session, action, at) => {
      calls.push({ ...action, at })
      if (action.action === "location") return { url: "http://127.0.0.1/page" }
      if (action.action === "snapshot") {
        if (action.ref === "e2") return { url: "", snapshot: `- checkbox "Terms" [e2] ${checkboxChecked ? "checked" : "unchecked"}`, collapsed: false }
        if (action.ref === "e3") return { url: "", snapshot: '- radio "Pro" [e3] checked', collapsed: false }
        if (action.ref === "e1") return { url: "", snapshot: '- button "Go" [e1]', collapsed: false }
        return { url: "", snapshot: '- button "Go" [e1]', collapsed: false }
      }
      if (action.action === "click" && action.ref === "e2") { checkboxChecked = !checkboxChecked; return { url: "" } }
      if (action.action === "wait") throw new Error('"Saved" did not appear within 0 ms')
      if (action.action === "click" && action.ref === "e9") throw new Error("Unknown or stale ref e9; take a new snapshot")
      return { url: "" }
    },
  }
  return { tab: new PreviewTab(host, "ses_1"), calls }
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
  assert.deepEqual(calls.at(-1), { action: "click", ref: "e1", at: "doc-1" })
  await tab.run({ type: "navigate", tabID: tab.id, url: "http://127.0.0.1/next" }, generation, signal)
  assert.equal((await tab.run({ type: "hover", tabID: tab.id, ref: "e1" }, generation, signal) as any).code, "document_changed",
    "a command selected for the previous document is refused")
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

test("back, forward, reload, check and fill_form", async () => {
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
  // Unchecked -> checked: clicks once.
  assert.equal((await tab.run({ type: "check", tabID: tab.id, ref: "e2", checked: true }, undefined, signal)).type, "success")
  assert.equal(calls.filter((c: any) => c.action === "click").length, 1)
  // Already checked -> no extra click.
  assert.equal((await tab.run({ type: "check", tabID: tab.id, ref: "e2", checked: true }, undefined, signal)).type, "success")
  assert.equal(calls.filter((c: any) => c.action === "click").length, 1)
  // Non-checkable control and unchecking a radio are refused.
  assert.equal((await tab.run({ type: "check", tabID: tab.id, ref: "e1", checked: true }, undefined, signal) as any).code, "operation_failed")
  assert.equal((await tab.run({ type: "check", tabID: tab.id, ref: "e3", checked: false }, undefined, signal) as any).code, "operation_failed")
  // fill_form runs text, select and check in order.
  calls.length = 0
  const filled = await tab.run({
    type: "fill_form", tabID: tab.id,
    fields: [
      { ref: "e4", type: "text", value: "Ada" },
      { ref: "e5", type: "select", values: ["Pro"] },
      { ref: "e2", type: "check", checked: false },
    ],
  }, undefined, signal)
  assert.equal(filled.type, "success")
  assert.deepEqual(calls.map((c: any) => c.action), ["type", "select", "snapshot", "click"])
})
