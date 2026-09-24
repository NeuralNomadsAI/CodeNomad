import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { WebPreferences } from "electron"
import { browserPartition, isBrowserUrlAllowed, secureBrowserWebview } from "./browser-webview-security"

describe("browser webview security", () => {
  it("accepts only credential-free HTTP(S) URLs in the browser partition", () => {
    assert.equal(isBrowserUrlAllowed("https://github.com/"), true)
    assert.equal(isBrowserUrlAllowed("file:///tmp/index.html"), false)
    assert.equal(isBrowserUrlAllowed("https://user:pass@example.com/"), false)
    assert.equal(isBrowserUrlAllowed("http://localhost:3000/"), true)
    assert.equal(isBrowserUrlAllowed("http://127.0.0.1:3000/"), true)

    const preferences = { preload: "malicious.js", nodeIntegration: true } as WebPreferences
    assert.equal(secureBrowserWebview(preferences, { partition: browserPartition("session_1"), src: "https://github.com/" }), true)
    assert.equal(preferences.preload, undefined)
    assert.equal(preferences.nodeIntegration, false)
    assert.equal(preferences.contextIsolation, true)
    assert.equal(preferences.sandbox, true)
    assert.equal(secureBrowserWebview({}, { partition: "persist:other", src: "https://github.com/" }), false)
    assert.equal(secureBrowserWebview({}, { partition: "persist:codenomad-browser-../other", src: "https://github.com/" }), false)
    assert.notEqual(browserPartition("session_1"), browserPartition("session_2"))
  })
})
