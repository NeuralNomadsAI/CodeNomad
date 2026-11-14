import assert from "node:assert/strict"
import test from "node:test"
import { remotePreviewAddress, remotePreviewSource } from "./remote-preview-address"

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

test("foreign capabilities, app origins and embedded credentials stay outside a preview mapping", () => {
  for (const source of ["http://other.preview.localhost:1234/previews/remote-token/start", "http://local-cap.preview.localhost:1235/start",
    "http://remote-app.test/start", "http://user:secret@local-cap.preview.localhost:1234/start", "javascript:alert(1)"]) {
    assert.equal(remotePreviewAddress(preview, source), undefined)
  }
  for (const address of ["http://other-app.test/start", "http://user:secret@remote-app.test/start", preview.contentUrl, "file:///etc/passwd"]) {
    assert.equal(remotePreviewSource(preview, address), undefined)
  }
})
