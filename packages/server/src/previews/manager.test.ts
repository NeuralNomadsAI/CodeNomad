import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PreviewManager } from "./manager"

describe("PreviewManager", () => {
  it("defaults loopback previews to HTTP and public hosts to HTTPS", () => {
    const manager = new PreviewManager()

    assert.equal(manager.create("session", "localhost:3000").targetUrl, "http://localhost:3000/")
    assert.equal(manager.create("session", "localhost?ready=1").targetUrl, "http://localhost/?ready=1")
    assert.equal(manager.create("session", "127.1:4173").targetUrl, "http://127.0.0.1:4173/")
    assert.equal(manager.create("session", "0.0.0.0:8080").targetUrl, "http://0.0.0.0:8080/")
    assert.equal(manager.create("session", "127.0.0.1:4173/app").targetUrl, "http://127.0.0.1:4173/app")
    assert.equal(manager.create("session", "example.com/app").targetUrl, "https://example.com/app")
  })

  it("rejects non-HTTP URLs and credentials", () => {
    const manager = new PreviewManager()

    assert.throws(() => manager.create("session", "javascript:alert(1)"), /HTTP or HTTPS/)
    assert.throws(() => manager.create("session", "https://user:secret@example.com"), /credentials/)
  })

  it("pins root and scheme-relative paths to the preview target origin", () => {
    const manager = new PreviewManager()
    const preview = manager.create("session", "http://localhost:3000/app")

    assert.equal(manager.buildTargetUrl(preview.token, `/previews/${preview.token}/`)?.href, "http://localhost:3000/")
    assert.equal(manager.buildTargetUrl(preview.token, `/previews/${preview.token}//127.0.0.1:9000/private`)?.href, "http://localhost:3000/127.0.0.1:9000/private")
  })
})
