import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parsePreviewCapabilityHost, rewritePreviewBodyUrls } from "../server/http-server"

describe("preview runtime rewriting", () => {
  it("recognizes only token-scoped localhost preview hosts", () => {
    assert.equal(parsePreviewCapabilityHost("12345678-1234-1234-1234-123456789abc.preview.localhost:9899"), "12345678-1234-1234-1234-123456789abc")
    assert.equal(parsePreviewCapabilityHost("preview.localhost:9899"), null)
    assert.equal(parsePreviewCapabilityHost("12345678-1234-1234-1234-123456789abc.example.com"), null)
  })

  it("installs the capability bridge before app scripts and rewrites static roots", () => {
    const html = rewritePreviewBodyUrls('<html><head><script src="/app.js"></script></head><body></body></html>', "/previews/token", "html", "http://localhost:3000")

    assert.ok(html.indexOf("codenomad-preview-location") < html.indexOf('src="/previews/token/app.js"'))
    assert.match(html, /window\.fetch=function/)
    assert.match(html, /window\.WebSocket=PreviewWebSocket/)
    assert.match(html, /codenomad-preview-comment-mode/)
    assert.match(html, /codenomad-preview-location/)
    assert.match(html, /targetHost/)
  })

  it("keeps Vite module imports under the capability path", () => {
    const source = 'import "/@vite/client"; import("/lazy.js"); export { value } from "/dep.js"; const example = \'import "/unchanged.js"\'; // import "/comment.js"'

    assert.equal(
      rewritePreviewBodyUrls(source, "/previews/token", "js"),
      'import "/previews/token/@vite/client"; import("/previews/token/lazy.js"); export { value } from "/previews/token/dep.js"; const example = \'import "/unchanged.js"\'; // import "/comment.js"',
    )
  })

  it("rewrites imports in inline module scripts", () => {
    const html = rewritePreviewBodyUrls('<script type="importmap">{"imports":{"app":"/app.js"}}</script><script type="module">import "/inline.js"</script>', "/previews/token", "html")

    assert.match(html, /"app":"\/previews\/token\/app\.js"/)
    assert.match(html, /import "\/previews\/token\/inline\.js"/)
  })
})
