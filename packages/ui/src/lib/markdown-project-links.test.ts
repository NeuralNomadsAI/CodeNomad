import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { projectLinkPath, resolveProjectLinkPath } from "./markdown-project-links"

describe("project-file link paths", () => {
  it("classifies project-file link candidates", () => {
    assert.equal(projectLinkPath("./README.md"), "README.md")
    assert.equal(projectLinkPath("README.md"), "README.md")
    assert.equal(projectLinkPath("docs/guide.md#intro"), "docs/guide.md")
    assert.equal(projectLinkPath("docs\\guide.md"), "docs/guide.md")
    assert.equal(projectLinkPath("src/a%20b.md"), "src/a b.md")
    assert.equal(projectLinkPath("C:\\Users\\me\\report.md"), "C:/Users/me/report.md")
    assert.equal(projectLinkPath("/home/me/repo/src/app.ts"), "/home/me/repo/src/app.ts")
    for (const source of ["", "#", "#section", "https://example.com/x", "http://x", "mailto:a@b.c",
      "javascript:alert(1)", "data:text/plain,x", "//cdn.example.com/a.png", "\\\\server\\share\\x.png"]) {
      assert.equal(projectLinkPath(source), undefined, source)
    }
  })

  it("resolves containment and rejects escapes", () => {
    const base = "/home/me/repo"
    assert.equal(resolveProjectLinkPath("./README.md", base), "README.md")
    assert.equal(resolveProjectLinkPath("docs/guide.md#intro", base), "docs/guide.md")
    assert.equal(resolveProjectLinkPath("/home/me/repo/src/app.ts", base), "src/app.ts")
    assert.equal(resolveProjectLinkPath("/etc/passwd", base), undefined)
    assert.equal(resolveProjectLinkPath("../outside.md", base), undefined)
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
