import assert from "node:assert/strict"
import test from "node:test"
import { remotePreviewAddress, remotePreviewContent, remotePreviewNavigationTarget, remotePreviewSource } from "./remote-preview-address"

const preview = { token: "remote-token", capability: "local-cap", contentUrl: "http://local-cap.preview.localhost:1234/previews/remote-token/start",
  targetUrl: "http://remote-app.test/start", sessionId: "session", createdAt: "", proxyUrl: "/previews/remote-token/start" }

test("remote preview addresses and loaded sources round-trip without persisting capabilities", () => {
  for (const path of ["/", "/next?q=1#fragment", "/a%20b/%25?q=%2F"]) {
    const address = `http://remote-app.test${path}`
    const source = remotePreviewSource(preview, address)!
    assert.equal(source, `http://local-cap.preview.localhost:1234/previews/remote-token${path}`)
    assert.equal(remotePreviewAddress(preview, source), address)
  }
  assert.equal(remotePreviewAddress(preview, "http://local-cap.preview.localhost:1234/root?q=2"), "http://remote-app.test/root?q=2")
})

test("remote clients map host path capabilities on their page origin, never other application paths", () => {
  const page = "https://host.example"
  const path = { ...preview, contentUrl: "/previews/local-cap/start" }
  assert.deepEqual(remotePreviewContent(path, page), { origin: page, prefix: "/previews/local-cap", opaque: true })
  assert.deepEqual(remotePreviewContent(preview, page), { origin: "http://local-cap.preview.localhost:1234", prefix: "/previews/remote-token", opaque: false })
  for (const address of ["http://remote-app.test/", "http://remote-app.test/next?q=1#fragment"]) {
    const source = remotePreviewSource(path, address, page)!
    assert.ok(source.startsWith(`${page}/previews/local-cap/`))
    assert.equal(source.includes("remote-token") || source.includes(".preview.localhost"), false)
    assert.equal(remotePreviewAddress(path, source, page), address)
  }
  for (const source of [`${page}/api/meta`, `${page}/previews/remote-token/start`, `${page}/previews/other-cap/start`, "https://other.example/previews/local-cap/start"]) {
    assert.equal(remotePreviewAddress(path, source, page), undefined)
  }
  for (const contentUrl of ["/previews/other-cap/start", "/previews/remote-token/start", "//evil.test/previews/local-cap/start"]) {
    assert.equal(remotePreviewContent({ ...preview, contentUrl }, page), undefined)
  }
  assert.equal(remotePreviewContent({ ...path, capability: "remote-token" }, page), undefined)
})

test("foreign capabilities, app origins and embedded credentials stay outside a preview mapping", () => {
  for (const source of ["http://other.preview.localhost:1234/previews/remote-token/start", "http://local-cap.preview.localhost:1235/start",
    "http://remote-app.test/start", "http://user:secret@local-cap.preview.localhost:1234/start", "javascript:alert(1)"]) {
    assert.equal(remotePreviewAddress(preview, source), undefined)
  }
  for (const address of ["http://other-app.test/start", "http://user:secret@remote-app.test/start", preview.contentUrl, "file:///etc/passwd"]) {
    assert.equal(remotePreviewSource(preview, address), undefined)
  }
})
test("an unmapped native commit can navigate only to an ordinary site address", () => {
  const ui = "http://127.0.0.1:43123"
  for (const stale of ["about:blank", "chrome-error://chromewebdata/", "http://old.preview.localhost:51234/previews/old/",
    `${ui}/previews/old/`, "/previews/old/", "https://user:pass@example.org/"]) {
    assert.equal(remotePreviewNavigationTarget(stale, ui), undefined, stale)
  }
  assert.equal(remotePreviewNavigationTarget("http://127.0.0.1:18852"), "http://127.0.0.1:18852/")
  assert.equal(remotePreviewNavigationTarget("https://example.org/previews/article", ui), "https://example.org/previews/article")
})
