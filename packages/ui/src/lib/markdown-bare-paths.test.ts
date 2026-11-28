import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { BARE_PATH_MAX_CANDIDATES, barePathCandidates, inlineCodeCandidates } from "./markdown-bare-paths"

const readings = (text: string) => barePathCandidates(text).flatMap(candidate =>
  candidate.integral ? [candidate.integral, ...candidate.pieces] : candidate.pieces)
const hrefs = (text: string) => readings(text).map(piece => piece.href)

describe("bare path candidates", () => {
  it("extracts paths embedded in prose", () => {
    assert.deepEqual(hrefs("The fix lives in src/app.ts now"), ["src/app.ts"])
    assert.deepEqual(hrefs("See README.md for details"), ["README.md"])
    assert.deepEqual(hrefs("edit /abs/path.ts please"), ["/abs/path.ts"])
  })

  it("extracts CJK-adjacent paths without word boundaries", () => {
    assert.deepEqual(hrefs("看看src/app.ts吧，就是那個檔案"), ["src/app.ts"])
  })

  it("extracts a path whose file name contains CJK letters as one integral reading", () => {
    const [candidate] = barePathCandidates("已写入 docs/superpowers/specs/2026-11-26-算法工作台MVP-design.md 定稿")
    assert.equal(candidate.integral?.href, "docs/superpowers/specs/2026-11-26-算法工作台MVP-design.md")
    // The boundary reading stays available when the integral name misses.
    assert.deepEqual(candidate.pieces.map(piece => piece.href),
      ["docs/superpowers/specs/2026-11-26-", "MVP-design.md"])
  })

  it("keeps CJK-wrapped tokens from reading as one file name", () => {
    const [candidate] = barePathCandidates("看看src/app.ts吧，就是那個檔案")
    assert.equal(candidate.integral, undefined)
    assert.deepEqual(candidate.pieces.map(piece => piece.href), ["src/app.ts"])
  })

  it("splits interior letter runs into fallback readings", () => {
    const [candidate] = barePathCandidates("对比 src/app.ts和docs/x.md 一下")
    assert.equal(candidate.integral?.href, "src/app.ts和docs/x.md")
    assert.deepEqual(candidate.pieces.map(piece => piece.href), ["src/app.ts", "docs/x.md"])
  })

  it("extracts bare CJK file names and Windows paths with CJK segments", () => {
    assert.equal(barePathCandidates("已写入 算法工作台MVP-design.md 了")[0]?.integral?.href,
      "算法工作台MVP-design.md")
    assert.equal(barePathCandidates("open C:\\repo\\中文\\app.ts there")[0]?.integral?.href,
      "C:\\repo\\中文\\app.ts")
  })

  it("treats any script's letters as file-name content", () => {
    assert.equal(barePathCandidates("see docs/результаты.md now")[0]?.integral?.href, "docs/результаты.md")
  })

  it("keeps CJK punctuation as a token boundary", () => {
    const [candidate] = barePathCandidates("规格写在 docs/算法.md，两处待确认。")
    assert.equal(candidate.integral?.href, "docs/算法.md")
  })

  it("rejects email-shaped text with CJK accounts", () => {
    assert.deepEqual(hrefs("mail 用户@例子.com now"), [])
  })

  it("keeps a Windows drive prefix glued to preceding prose", () => {
    const [candidate] = barePathCandidates("打开C:\\repo\\src\\app.ts")
    assert.deepEqual(candidate.pieces.map(piece => piece.href), ["C:\\repo\\src\\app.ts"])
    const [wrapped] = barePathCandidates("看看C:\\repo\\src\\app.ts吧")
    assert.equal(wrapped.integral, undefined)
    assert.deepEqual(wrapped.pieces.map(piece => piece.href), ["C:\\repo\\src\\app.ts"])
  })

  it("caps readings, not tokens", () => {
    const text = Array.from({ length: BARE_PATH_MAX_CANDIDATES * 3 }, (_, index) => `d${index}/x.md`).join("和")
    const candidates = barePathCandidates(text)
    assert.equal(candidates.length, 1)
    const [token] = candidates
    assert.equal((token.integral ? 1 : 0) + token.pieces.length, BARE_PATH_MAX_CANDIDATES)
  })

  it("trims exposed trailing punctuation once edge letter runs are trimmed", () => {
    const [candidate] = barePathCandidates("看看README.md.吧")
    assert.deepEqual(candidate.pieces.map(piece => piece.href), ["README.md"])
  })

  it("probes a both-edges token whose boundary reading is degenerate", () => {
    const [candidate] = barePathCandidates("脚本/启动")
    assert.equal(candidate.integral?.href, "脚本/启动")
  })

  it("offers no readings from a URL whose path contains non-ASCII letters", () => {
    assert.deepEqual(barePathCandidates("see https://example.com/资料README.md now"), [])
    assert.deepEqual(barePathCandidates("see //example.com/资料README.md now"), [])
  })

  it("probes a both-edges token whose edge runs are path segments", () => {
    const [candidate] = barePathCandidates("放进 项目/v2/启动 里")
    assert.equal(candidate.integral?.href, "项目/v2/启动")
  })

  it("splits a single-letter-colon prefix like a scheme, not a drive", () => {
    const [candidate] = barePathCandidates("see File:/fixture-root/README.md there")
    assert.deepEqual(candidate.pieces.map(piece => piece.href), ["/fixture-root/README.md"])
  })

  it("leaves percent-escaped prose plain when the escape could name another file", () => {
    // A percent escape decodes to a different literal path than the text
    // shows, so the span's literal text, the verified target and the
    // generated destination cannot agree — the same rule inline code
    // follows. A literal percent sign that decodes to nothing still links.
    assert.deepEqual(hrefs("see docs/%E7%AE%97.md there"), [])
    assert.deepEqual(hrefs("see 100%25.md there"), [])
    assert.deepEqual(hrefs("see 100%.md there"), ["100%.md"])
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
    const text = "见 docs/算法工作台.md 和 docs/x.md 吧"
    for (const candidate of barePathCandidates(text)) {
      for (const piece of candidate.integral ? [candidate.integral, ...candidate.pieces] : candidate.pieces) {
        assert.equal(text.slice(piece.start, piece.end), piece.href)
      }
    }
  })

  it("keeps the match start when trimming the candidate's end", () => {
    const text = "See src/app.ts."
    const [candidate] = barePathCandidates(text)
    const [piece] = candidate.pieces
    assert.equal(text.slice(piece.start, piece.end), piece.href)
    assert.equal(piece.href, "src/app.ts")
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

  it("does not rewrite inline code as a URL or trim literal punctuation", () => {
    for (const invalid of [" src/app.ts ", "src/app.ts!", "src/app.ts?", "src/a\tpp.ts", "src/app.ts\n", "//host/app.ts", ".//src/app.ts"]) {
      assert.deepEqual(inlineCodeCandidates(invalid), [], JSON.stringify(invalid))
    }
    assert.deepEqual(inlineCodeCandidates("src/app.ts.").map(candidate => candidate.href), ["src/app.ts."])
  })

  it("rejects numeric dates and ratios as bare paths", () => {
    assert.deepEqual(hrefs("27/11/2026 passed 52/52 checks and 7/10 or 989/1000"), [])
    assert.deepEqual(inlineCodeCandidates("27/11/2026"), [])
    assert.deepEqual(inlineCodeCandidates("989/1000"), [])
    assert.deepEqual(hrefs("see docs/2026-11-26-plan.md and 2026/notes.md"), ["docs/2026-11-26-plan.md", "2026/notes.md"])
  })

  it("recognizes spans whose edges are hyphen-glued CJK segments", () => {
    assert.deepEqual(inlineCodeCandidates("前端-v2/run-测试").map(candidate => candidate.href),
      ["前端-v2/run-测试"])
  })
})
