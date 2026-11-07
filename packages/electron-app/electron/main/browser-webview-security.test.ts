import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { WebPreferences } from "electron"
import { browserPartition, isBrowserUrlAllowed, isBrowserSiteUrlAllowed, isBrowserDownloadUrlAllowed, secureBrowserWebview } from "./browser-webview-security"

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
  it("allows blank OAuth windows and only same-origin blob documents without weakening typed URLs", () => {
    assert.equal(isBrowserSiteUrlAllowed("about:blank", "https://example.com/"), true)
    assert.equal(isBrowserSiteUrlAllowed("blob:https://example.com/id", "https://example.com/"), true)
    assert.equal(isBrowserSiteUrlAllowed("blob:https://other.example/id", "https://example.com/"), false)
    assert.equal(isBrowserSiteUrlAllowed("file:///private", "https://example.com/"), false)
    assert.equal(isBrowserUrlAllowed("about:blank"), false)
    assert.equal(isBrowserDownloadUrlAllowed("data:image/png;base64,AA", "https://example.com/"), true)
    assert.equal(isBrowserDownloadUrlAllowed("file:///private", "https://example.com/"), false)
  })
})
