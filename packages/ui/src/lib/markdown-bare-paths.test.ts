import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { BARE_PATH_MAX_CANDIDATES, barePathCandidates, candidateParentDirectory } from "./markdown-bare-paths"

const hrefs = (text: string) => barePathCandidates(text).map(candidate => candidate.href)

describe("bare path candidates", () => {
  it("extracts paths embedded in prose", () => {
    assert.deepEqual(hrefs("The fix lives in src/app.ts now"), ["src/app.ts"])
    assert.deepEqual(hrefs("See README.md for details"), ["README.md"])
    assert.deepEqual(hrefs("edit /abs/path.ts please"), ["/abs/path.ts"])
  })

  it("extracts CJK-adjacent paths without word boundaries", () => {
    assert.deepEqual(hrefs("看看src/app.ts吧，就是那個檔案"), ["src/app.ts"])
  })

  it("extracts Windows drive and backslash paths whole", () => {
    assert.deepEqual(hrefs("open C:\\repo\\src\\app.ts there"), ["C:\\repo\\src\\app.ts"])
    assert.deepEqual(hrefs("open C:/repo/src/app.ts there"), ["C:/repo/src/app.ts"])
  })

  it("trims trailing punctuation from candidates", () => {
    assert.deepEqual(hrefs("see src/app.ts."), ["src/app.ts"])
    assert.deepEqual(hrefs("see (src/app.ts) there"), ["src/app.ts"])
    assert.deepEqual(hrefs("see src/app.ts, yes"), ["src/app.ts"])
  })

  it("keeps separator-bearing false positives as candidates", () => {
    assert.deepEqual(hrefs("and/or"), ["and/or"])
  })

  it("rejects URL-shaped, email-shaped, fragment and bare-word text", () => {
    assert.deepEqual(hrefs("visit https://example.com/x"), [])
    assert.deepEqual(hrefs("mail me at a@b.c please"), [])
    assert.deepEqual(hrefs("see mailto:a@b.c"), [])
    assert.deepEqual(hrefs("jump to #fragment"), [])
    assert.deepEqual(hrefs("just hello"), [])
    assert.deepEqual(hrefs("visit s://example.com/x"), [])
  })

  it("never returns a candidate spanning a space", () => {
    assert.equal(hrefs("my file.md").includes("my file.md"), false)
    assert.equal(hrefs("my file.md").includes("my"), false)
  })

  it("caps candidates per call", () => {
    const text = Array.from({ length: BARE_PATH_MAX_CANDIDATES + 6 }, (_, index) => `d/f${index}.ts`).join(" ")
    const candidates = barePathCandidates(text)
    assert.equal(candidates.length, BARE_PATH_MAX_CANDIDATES)
  })

  it("reports byte-consistent spans of the original text", () => {
    const text = "one src/app.ts two"
    const [candidate] = barePathCandidates(text)
    assert.equal(text.slice(candidate.start, candidate.end), candidate.href)
  })
})

describe("candidate parent directories", () => {
  it("groups candidates by their leading directories", () => {
    assert.equal(candidateParentDirectory("src/app.ts"), "src")
    assert.equal(candidateParentDirectory("a/b/c.md"), "a/b")
    assert.equal(candidateParentDirectory("README.md"), "")
    assert.equal(candidateParentDirectory("C:\\repo\\src\\app.ts"), "C:/repo/src")
    assert.equal(candidateParentDirectory("./docs/guide.md"), "./docs")
  })
})
