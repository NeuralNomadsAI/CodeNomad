import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PreviewManager, isLoopbackHostname, previewDocumentSandbox, previewDocumentSandboxForTarget } from "./manager"

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

  it("recognizes loopback hostnames case-insensitively", () => {
    for (const hostname of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "0.0.0.0", "::1", "[::1]"]) {
      assert.equal(isLoopbackHostname(hostname), true, hostname)
    }
    for (const hostname of ["example.com", "sub.localhost", "localhost.evil.com", "192.168.1.5", ""]) {
      assert.equal(isLoopbackHostname(hostname), false, hostname)
    }
  })

  it("the document sandbox keeps the app origin only for loopback targets", () => {
    const external = previewDocumentSandbox(false)
    assert.equal(external, "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads")
    assert.equal(external.includes("allow-same-origin"), false)
    assert.equal(previewDocumentSandbox(true), `${external} allow-same-origin`)
  })

  it("maps a preview target URL to its response sandbox tier", () => {
    assert.equal(previewDocumentSandboxForTarget("http://localhost:3000/app"), previewDocumentSandbox(true))
    assert.equal(previewDocumentSandboxForTarget("http://127.0.0.1:8080"), previewDocumentSandbox(true))
    assert.equal(previewDocumentSandboxForTarget("https://example.com/page"), previewDocumentSandbox(false))
    assert.equal(previewDocumentSandboxForTarget("http://[::1]:5173/"), previewDocumentSandbox(true))
    assert.equal(previewDocumentSandboxForTarget("http://192.168.1.5:3000/"), previewDocumentSandbox(false))
  })
})
