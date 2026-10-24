import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { getBrowserFramePolicy, getPreviewFrameSource, isLoopbackHttpUrl, isLoopbackPreviewUrl, normalizeBrowserPreviewUrl } from "./browser-frame-security.ts"

describe("getBrowserFramePolicy", () => {
  it("isolates local native frames from the parent bridge", () => {
    for (const host of ["electron", "tauri"] as const) {
      const policy = getBrowserFramePolicy({ host, windowContext: "local" })
      const permissions = new Set(policy.sandbox?.split(" "))

      assert.deepEqual(permissions, new Set(["allow-scripts", "allow-forms", "allow-modals", "allow-popups", "allow-downloads"]))
      assert.equal(permissions.has("allow-same-origin"), false)
      assert.equal([...permissions].some((permission) => permission.startsWith("allow-top-navigation")), false)
      assert.equal(policy.canInspectDom, false)
    }
  })

  it("isolates browser-hosted frames from the authenticated parent", () => {
    assert.deepEqual(getBrowserFramePolicy({ host: "web", windowContext: "remote" }), {
      sandbox: "allow-scripts allow-forms allow-modals allow-popups allow-downloads",
      canInspectDom: false,
    })
  })

  it("keeps app-proxied SideCar frames same-origin so their requests carry the session cookie", () => {
    for (const host of ["web", "electron", "tauri"] as const) {
      const policy = getBrowserFramePolicy({ host, windowContext: "local" }, { trustedSameOrigin: true })
      const permissions = new Set(policy.sandbox?.split(" "))

      assert.deepEqual(
        permissions,
        new Set(["allow-scripts", "allow-forms", "allow-modals", "allow-popups", "allow-downloads", "allow-same-origin"]),
      )
      assert.equal(policy.canInspectDom, false)
    }
  })

  it("uses a token-scoped localhost origin for native previews", () => {
    const preview = { token: "12345678-1234-1234-1234-123456789abc", targetUrl: "http://localhost:3000/app?q=1#hash", proxyUrl: "/previews/token/app" }

    assert.equal(
      getPreviewFrameSource({ host: "tauri", windowContext: "local" }, preview, "http://127.0.0.1:9899/"),
      "http://12345678-1234-1234-1234-123456789abc.preview.localhost:9899/app?q=1#hash",
    )
    assert.equal(getPreviewFrameSource({ host: "web", windowContext: "remote" }, preview, "https://app.example/"), preview.proxyUrl)
    assert.equal(getPreviewFrameSource({ host: "tauri", windowContext: "local" }, preview, "https://localhost:9898/"), preview.proxyUrl)
    assert.equal(getPreviewFrameSource({ host: "tauri", windowContext: "local" }, preview, "http://192.168.1.10:9899/"), preview.proxyUrl)
  })
})

describe("isLoopbackPreviewUrl", () => {
  it("separates local previews from public browser pages", () => {
    assert.equal(isLoopbackPreviewUrl("http://localhost:3000/app"), true)
    assert.equal(isLoopbackPreviewUrl("localhost:5173"), true)
    assert.equal(isLoopbackPreviewUrl("http://127.0.0.8:5173/"), true)
    assert.equal(isLoopbackPreviewUrl("127.0.0.1:5173/app"), true)
    assert.equal(isLoopbackPreviewUrl("[::1]:4173"), true)
    assert.equal(isLoopbackPreviewUrl("https://github.com/"), false)
  })
})

describe("isLoopbackHttpUrl", () => {
  it("accepts only explicit http(s) URLs whose host is loopback", () => {
    assert.equal(isLoopbackHttpUrl("http://localhost:3000/app"), true)
    assert.equal(isLoopbackHttpUrl("http://127.0.0.1:8080"), true)
    assert.equal(isLoopbackHttpUrl("http://127.1.2.3:80/"), true)
    assert.equal(isLoopbackHttpUrl("https://localhost/"), true)
    assert.equal(isLoopbackHttpUrl("http://[::1]:5173/"), true)
    assert.equal(isLoopbackHttpUrl("http://0.0.0.0:3000/"), true)
    assert.equal(isLoopbackHttpUrl("https://example.com/"), false)
    assert.equal(isLoopbackHttpUrl("localhost:3000"), false)
    assert.equal(isLoopbackHttpUrl("/relative"), false)
    assert.equal(isLoopbackHttpUrl("#anchor"), false)
    assert.equal(isLoopbackHttpUrl("mailto:a@b.c"), false)
    assert.equal(isLoopbackHttpUrl("http://192.168.1.5:3000/"), false)
    assert.equal(isLoopbackHttpUrl(""), false)
  })
})

describe("normalizeBrowserPreviewUrl", () => {
  it("defaults public hosts to HTTPS and loopback hosts to HTTP", () => {
    assert.equal(normalizeBrowserPreviewUrl("github.com"), "https://github.com/")
    assert.equal(normalizeBrowserPreviewUrl("localhost:5173/app"), "http://localhost:5173/app")
    assert.throws(() => normalizeBrowserPreviewUrl("file:///tmp/index.html"))
    assert.throws(() => normalizeBrowserPreviewUrl("https://user:pass@example.com"))
  })
})
