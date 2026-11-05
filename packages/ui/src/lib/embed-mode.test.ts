import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  embeddedProjectUrl, readEmbeddedProject, readEmbeddedProjectReport, rememberEmbeddedSession, rememberedEmbeddedSession,
} from "./embed-mode.ts"

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}

describe("embedded active session memory", () => {
  it("keeps one valid session per folder in the page's own storage", () => {
    const storage = memoryStorage()
    assert.equal(rememberedEmbeddedSession("/srv/app", storage), undefined)
    rememberEmbeddedSession("/srv/app", "ses_abc-1", storage)
    rememberEmbeddedSession("/srv/other", "ses_other", storage)
    assert.equal(rememberedEmbeddedSession("/srv/app", storage), "ses_abc-1")
    rememberEmbeddedSession("/srv/app", "ses_newer", storage)
    assert.equal(rememberedEmbeddedSession("/srv/app", storage), "ses_newer")
    assert.equal(rememberedEmbeddedSession("/srv/other", storage), "ses_other")
    // Malformed identifiers are neither written nor trusted when read back.
    rememberEmbeddedSession("/srv/app", "../../x", storage)
    assert.equal(rememberedEmbeddedSession("/srv/app", storage), "ses_newer")
    storage.setItem("codenomad:embedded-session:/srv/bad", "<script>")
    assert.equal(rememberedEmbeddedSession("/srv/bad", storage), undefined)
  })

  it("survives unavailable storage", () => {
    const failing = { getItem: () => { throw new Error("denied") }, setItem: () => { throw new Error("denied") } } as unknown as Storage
    assert.doesNotThrow(() => rememberEmbeddedSession("/srv/app", "ses_a", failing))
    assert.equal(rememberedEmbeddedSession("/srv/app", failing), undefined)
  })
})

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
