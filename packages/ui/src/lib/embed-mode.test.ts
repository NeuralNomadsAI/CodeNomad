import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { embeddedProjectUrl, readEmbeddedProject, readEmbeddedProjectReport } from "./embed-mode.ts"

describe("embedded single-project mode", () => {
  it("is selected only by its exact parameter and keeps a bounded folder", () => {
    assert.equal(readEmbeddedProject(""), null)
    assert.equal(readEmbeddedProject("?codenomadEmbed=full"), null)
    assert.equal(readEmbeddedProject("?embed=project"), null)
    assert.deepEqual(readEmbeddedProject("?codenomadEmbed=project"), {})
    assert.deepEqual(readEmbeddedProject("?codenomadEmbed=project&folder=%2Fsrv%2Fapp"), { folder: "/srv/app" })
    assert.deepEqual(readEmbeddedProject("?codenomadEmbed=project&folder=%20%20"), {})
    assert.deepEqual(readEmbeddedProject(`?codenomadEmbed=project&folder=${"a".repeat(4097)}`), {})
  })

  it("builds the entry at the server root, dropping any path, query or fragment", () => {
    assert.equal(embeddedProjectUrl("https://box.example:8443/old/path?x=1#y"), "https://box.example:8443/?codenomadEmbed=project")
    const withFolder = new URL(embeddedProjectUrl("http://127.0.0.1:9900", "C:\\work\\app & co"))
    assert.equal(withFolder.origin, "http://127.0.0.1:9900")
    assert.deepEqual(readEmbeddedProject(withFolder.search), { folder: "C:\\work\\app & co" })
  })

  it("lets a host accept only a same-origin report that names a folder", () => {
    const origin = "https://box.example"
    const entry = embeddedProjectUrl(origin, "/srv/app")
    assert.deepEqual(readEmbeddedProjectReport(entry, "  App  ", origin), { folder: "/srv/app", title: "App" })
    // An older server keeps the bare entry: its own title never relabels the tab.
    assert.equal(readEmbeddedProjectReport(embeddedProjectUrl(origin), "CodeNomad", origin), null)
    assert.equal(readEmbeddedProjectReport(entry, "App", "https://other.example"), null)
    assert.equal(readEmbeddedProjectReport(entry, "   ", origin), null)
    assert.equal(readEmbeddedProjectReport("not a url", "App", origin), null)
    assert.equal(readEmbeddedProjectReport(`${origin}/?folder=%2Fsrv`, "App", origin), null)
    assert.equal(readEmbeddedProjectReport(entry, "x".repeat(400), origin)?.title.length, 256)
  })
})
