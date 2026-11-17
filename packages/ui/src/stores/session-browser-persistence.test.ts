import assert from "node:assert/strict"
import { test } from "node:test"
import { mergeSessionBrowsers, normalizeTabViewState, tabPreviewModes, type RestorableTabViewState } from "./tab-view-state-codec"

test("active/MRU occurrence wins a session browser merge while other sessions and foreground choices survive", () => {
  const view = (url: string, mode: "chat" | "preview"): RestorableTabViewState => ({ version: 1,
    previews: { shared: { mode, targetUrl: url, viewport: "mobile",
      history: { urls: ["https://example.com/start", url], index: 1 } } } })
  const active = view("https://example.com/active", "chat"), sibling = view("https://example.com/other", "preview")
  sibling.previews!.only = { mode: "chat", targetUrl: "https://example.com/only" }
  const merged = JSON.parse(mergeSessionBrowsers([active, sibling], null))
  assert.equal(merged.shared.targetUrl, "https://example.com/active")
  assert.deepEqual(merged.shared.history, active.previews!.shared.history)
  assert.equal(merged.shared.viewport, "mobile")
  assert.equal(merged.only.targetUrl, "https://example.com/only")
  assert.deepEqual(tabPreviewModes(active), { version: 1, previews: { shared: { mode: "chat" } } })
  assert.deepEqual(tabPreviewModes(sibling).previews!.shared, { mode: "preview" })
  assert.deepEqual(normalizeTabViewState(tabPreviewModes(active)), tabPreviewModes(active))
})

test("a mode-only restore preserves the saved URL and rejects unsafe imported destinations", () => {
  const stored = JSON.stringify({ shared: { mode: "chat", targetUrl: "https://example.com/saved" } })
  const view = normalizeTabViewState({ version: 1, previews: {
    shared: { mode: "preview" }, unsafe: { mode: "preview", targetUrl: "javascript:alert(1)" },
  } })!
  assert.deepEqual(JSON.parse(mergeSessionBrowsers([view], stored)), JSON.parse(stored))
  assert.deepEqual(view.previews, { shared: { mode: "preview" } })
})
