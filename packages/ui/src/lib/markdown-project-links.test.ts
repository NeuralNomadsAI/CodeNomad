import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { localFileUrlPath, projectLinkPath, resolveProjectLinkPath } from "./markdown-project-links"

describe("project-file link paths", () => {
  it("classifies project-file link candidates", () => {
    assert.equal(projectLinkPath("./README.md"), "README.md")
    assert.equal(projectLinkPath("README.md"), "README.md")
    assert.equal(projectLinkPath("docs/guide.md#intro"), "docs/guide.md")
    assert.equal(projectLinkPath("docs\\guide.md"), "docs/guide.md")
    assert.equal(projectLinkPath("src/a%20b.md"), "src/a b.md")
    assert.equal(projectLinkPath("C:\\Users\\me\\report.md"), "C:/Users/me/report.md")
    assert.equal(projectLinkPath("/home/me/repo/src/app.ts"), "/home/me/repo/src/app.ts")
    // Percent-encoded schemes and scheme-relative values must not survive decoding.
    assert.equal(projectLinkPath("%2F%2Fcdn.example.com/a.png"), undefined)
    assert.equal(projectLinkPath("javascript%3Aalert(1)"), undefined)
    assert.equal(projectLinkPath("data%3Atext/plain,x"), undefined)
    assert.equal(projectLinkPath("C%3A/Users/me/report.md"), "C:/Users/me/report.md")
    for (const source of ["", "#", "#section", "https://example.com/x", "http://x", "mailto:a@b.c",
      "javascript:alert(1)", "data:text/plain,x", "//cdn.example.com/a.png", "\\\\server\\share\\x.png"]) {
      assert.equal(projectLinkPath(source), undefined, source)
    }
    // Encoded backslashes cannot smuggle a UNC path past the `//` check.
    assert.equal(projectLinkPath("/%5Cfixture.invalid%5Cshare%5Cnotes.txt"), undefined)
    assert.equal(projectLinkPath("/"), "/")
    assert.equal(projectLinkPath("C:/"), "C:/")
    assert.equal(projectLinkPath("./"), ".")
    assert.equal(resolveProjectLinkPath("./", "/home/me/repo"), undefined)
  })

  it("reads local file URLs", () => {
    assert.equal(localFileUrlPath("file:///C:/Users/me/My%20reports"), "C:/Users/me/My reports")
    assert.equal(localFileUrlPath("file://localhost/home/me/repo/docs/?view=%2F#top"), "/home/me/repo/docs/")
    assert.equal(localFileUrlPath("file:/home/me/repo/docs"), "/home/me/repo/docs")
    assert.equal(localFileUrlPath("file:///"), "/")
    assert.equal(localFileUrlPath("file:///C:/"), "C:/")
    assert.equal(localFileUrlPath("file:C:/Users/me/notes.txt"), "C:/Users/me/notes.txt")
    assert.equal(localFileUrlPath("file://C:/Users/me/notes.txt"), "C:/Users/me/notes.txt")
    assert.equal(localFileUrlPath("file:///C:\\Users\\me\\notes.md"), "C:/Users/me/notes.md")
    assert.equal(localFileUrlPath("file:C:\\Users\\me\\notes.txt"), "C:/Users/me/notes.txt")
    for (const source of ["C:/Users/me/bato.jpg", "file://server/share/x.md", "file:///home/me/docs%2Fchild",
      "file:///%5C%5Cserver%5Cshare", "file:///\\\\server\\share\\x.md", "file:////server/share/x.md", "https://example.com/x"]) {
      assert.equal(localFileUrlPath(source), undefined, source)
    }  })

  it("resolves containment and rejects escapes", () => {
    const base = "/home/me/repo"
    assert.equal(resolveProjectLinkPath("./README.md", base), "README.md")
    assert.equal(resolveProjectLinkPath("docs/guide.md#intro", base), "docs/guide.md")
    assert.equal(resolveProjectLinkPath("/home/me/repo/src/app.ts", base), "src/app.ts")
    assert.equal(resolveProjectLinkPath("/etc/passwd", base), undefined)
    assert.equal(resolveProjectLinkPath("../outside.md", base), undefined)
    assert.equal(resolveProjectLinkPath("%2e%2e/outside.md", base), undefined)
    assert.equal(resolveProjectLinkPath("a/../b.md", base), "b.md")
    assert.equal(resolveProjectLinkPath("./", base), undefined)
  })

  it("resolves Windows paths case-insensitively", () => {
    const base = "C:/Users/me/repo"
    assert.equal(resolveProjectLinkPath("src\\app.ts", base), "src/app.ts")
    assert.equal(resolveProjectLinkPath("c:/users/ME/repo/src/app.ts", base), "src/app.ts")
    assert.equal(resolveProjectLinkPath("C:/Users/other/x.md", base), undefined)
  })
})
