import assert from "node:assert/strict"
import { it } from "node:test"
import { PreviewManager, isLoopbackHostname, previewDocumentSandbox } from "./manager"

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

it("creates previews for any http(s) target, defaulting implicit loopback to http", () => {
  const manager = new PreviewManager()
  const loopback = manager.create("session", "localhost:3000/app")
  assert.equal(loopback.targetUrl, "http://localhost:3000/app")
  const external = manager.create("session", "https://example.com/page")
  assert.equal(external.targetUrl, "https://example.com/page")
  assert.throws(() => manager.create("session", "ftp://localhost:21"))
  assert.throws(() => manager.create("session", "https://user:pass@example.com"))
})
