import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { BARE_PATH_MAX_CANDIDATES, barePathCandidates, inlineCodeCandidates } from "./markdown-bare-paths"

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

  it("keeps paths whose file names contain CJK letters as prose boundaries", () => {
    // The CJK name splits the path into fragments that stay legal candidates;
    // existence gating downstream decides they convert nothing.
    assert.deepEqual(hrefs("已写入 docs/superpowers/specs/2026-11-26-算法工作台MVP-design.md 定稿"),
      ["docs/superpowers/specs/2026-11-26-", "MVP-design.md"])
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

  it("keeps the match start when trimming the candidate's end", () => {
    const text = "See src/app.ts."
    const [candidate] = barePathCandidates(text)
    assert.equal(text.slice(candidate.start, candidate.end), candidate.href)
    assert.equal(candidate.href, "src/app.ts")
  })

  it("keeps a space-truncated suffix as its own candidate", () => {
    // A path containing a space cannot be recovered from prose; its last
    // space-free segment stays a legal candidate that existence gating
    // decides — it links only when that file exists in the worktree.
    assert.deepEqual(hrefs("my file.md"), ["file.md"])
  })
})

describe("inline code candidates", () => {
  it("offers the code span's whole content as one exact candidate", () => {
    assert.deepEqual(inlineCodeCandidates("src/app.ts").map(candidate => candidate.href), ["src/app.ts"])
    assert.deepEqual(inlineCodeCandidates("docs/算法工作台MVP-design.md").map(candidate => candidate.href),
      ["docs/算法工作台MVP-design.md"])
    assert.deepEqual(inlineCodeCandidates("C:\\repo\\src\\app.ts").map(candidate => candidate.href),
      ["C:\\repo\\src\\app.ts"])
  })

  it("never falls back from a missing or URL-shaped span to same-named files", () => {
    assert.deepEqual(inlineCodeCandidates("docs/不存在README.md").map(candidate => candidate.href),
      ["docs/不存在README.md"])
    assert.deepEqual(inlineCodeCandidates("https://example.test/guide#README.md"), [])
    assert.deepEqual(inlineCodeCandidates("npm run build"), [])
    assert.deepEqual(inlineCodeCandidates("useState"), [])
  })

  it("leaves fragment-bearing and percent-escaped spans plain", () => {
    // A `#` would be read as a URL fragment and a percent escape as an
    // encoding of a different literal, so the verified target, the generated
    // destination and the span's literal text can disagree.
    assert.deepEqual(inlineCodeCandidates("docs/issue#42.md"), [])
    assert.deepEqual(inlineCodeCandidates("issue#42"), [])
    assert.deepEqual(inlineCodeCandidates("docs/%E7%AE%97.md"), [])
    assert.deepEqual(inlineCodeCandidates("./docs/issue#42.md"), [])
  })

  it("trims surrounding spaces and trailing punctuation", () => {
    assert.deepEqual(inlineCodeCandidates("  src/app.ts. ").map(candidate => candidate.href), ["src/app.ts"])
  })

  it("recognizes spans whose edges are hyphen-glued CJK segments", () => {
    assert.deepEqual(inlineCodeCandidates("前端-v2/run-测试").map(candidate => candidate.href),
      ["前端-v2/run-测试"])
  })
})
