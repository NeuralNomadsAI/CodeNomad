import assert from "node:assert/strict"
import test from "node:test"
import { decideNavigation, requireHttpUrl } from "./navigation-security"
import { pinnedBlenderCatalog } from "../../../server/src/opencode/integrations/catalog-pinned-fixture"
import { isIntegrationDocsUrl } from "../../../server/src/panel-extensions/bundles-docs"

test("remote window URLs require HTTP or HTTPS", () => {
  assert.equal(requireHttpUrl("http://localhost:3000/app", "baseUrl").protocol, "http:")
  assert.equal(requireHttpUrl("https://example.com/app", "entryUrl").protocol, "https:")
  for (const url of ["file:///tmp/index.html", "data:text/html,hello", "javascript:alert(1)"]) {
    assert.throws(() => requireHttpUrl(url, "baseUrl"), /must use HTTP or HTTPS/)
  }
})

test("navigation allows registered origins and only the exact loading file", () => {
  const loading = "file:///opt/codenomad/loading.html"
  const origins = ["https://renderer.example"]
  assert.equal(decideNavigation(loading, origins, loading), "allow")
  assert.equal(decideNavigation("file:///opt/codenomad/index.html", origins, loading), "deny")
  assert.equal(decideNavigation("https://renderer.example/workspace", origins, loading), "allow")
  assert.equal(decideNavigation("https://outside.example/", origins, loading), "external")
  assert.equal(decideNavigation("mailto:hello@example.com", origins, loading), "external")
  assert.equal(decideNavigation("vscode://file/C:/workspace", origins, loading), "deny")
  assert.equal(decideNavigation("not a URL", origins, loading), "deny")
  assert.equal(decideNavigation("http://localhost:5173/loading.html", [], "http://localhost:5173/loading.html"), "allow")
})

test("canonical integration documentation stays an external destination for local and remote windows", () => {
  const entry = pinnedBlenderCatalog().integrations[0]!, docs = entry.docs
  assert(isIntegrationDocsUrl(docs, entry.id))
  assert(!isIntegrationDocsUrl(docs, "houdini"))
  for (const origins of [["http://127.0.0.1:43123"], ["https://remote.example"]]) {
    assert.equal(decideNavigation(docs, origins, "file:///fixture/loading.html"), "external")
    for (const target of ["javascript:alert(1)", "file:///private/secret", "vscode://file/private"]) {
      assert.equal(decideNavigation(target, origins, "file:///fixture/loading.html"), "deny")
    }
  }
})
