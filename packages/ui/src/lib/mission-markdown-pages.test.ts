import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { marked, type Tokens } from "marked"
import { renderMarkdown } from "./markdown"
import { missionMarkdownPage } from "./mission-markdown-pages"

function pages(text: string, pageSize = 9_000) {
  return Array.from({ length: Math.max(1, Math.ceil(text.length / pageSize)) }, (_, page) => missionMarkdownPage(text, page, pageSize))
}

function codeText(markdown: string) {
  return marked.lexer(markdown).filter((token): token is Tokens.Code => token.type === "code")
    .map(token => token.text).join("\n")
}

describe("missionMarkdownPage", () => {
  it("keeps ordinary Markdown excerpts unchanged and handles empty/out-of-range pages", () => {
    const text = "# Heading\n\n**paragraph**\n\n| a | b |\n| - | - |\n| c | d |"
    for (const [index, page] of pages(text, 15).entries()) {
      assert.equal(page.sourceText, text.slice(index * 15, (index + 1) * 15))
      assert.equal(page.markdownText, page.sourceText)
    }
    assert.deepEqual(missionMarkdownPage("", 0), { sourceText: "", markdownText: "" })
    assert.deepEqual(missionMarkdownPage(text, 50), { sourceText: "", markdownText: "" })
  })

  for (const marker of ["```", "~~~~", "`````", "~~~"]) {
    it(`renders first, middle and final ${marker} pages as code, with trailing prose`, () => {
      const text = `Before **code**\n\n${marker}typescript\n` + "const value = '<tag>';\n".repeat(1_100)
        + `${marker}\n\nAfter **code**`
      const result = pages(text)
      assert.equal(result.map(page => page.sourceText).join(""), text)
      assert.ok(result.length >= 3)
      for (const page of result) {
        assert.notEqual(page.markdownText, null)
        assert.ok(page.markdownText!.length < 10_000)
        assert.match(codeText(page.markdownText!), /const value/)
      }
      assert.ok(result[1].markdownText!.startsWith(`${marker}typescript\n`))
      assert.match(marked.parse(result[0].markdownText!) as string, /<strong>code<\/strong>/)
      assert.match(marked.parse(result.at(-1)!.markdownText!) as string, /After <strong>code<\/strong>/)
    })
  }

  it("keeps surrogate pairs together with exact continuity across every page", () => {
    for (const size of [1, 2, 7, 9_000]) {
      const text = "a".repeat(size - 1) + "😀" + "b".repeat(size - 1) + "🧪end"
      const result = pages(text, size)
      assert.equal(result.map(page => page.sourceText).join(""), text)
      for (const page of result) {
        assert.ok(page.sourceText.length <= size + 1)
        assert.doesNotMatch(page.sourceText, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
      }
    }
  })

  it("retains partial opener and closer source verbatim through literal-code fallback", () => {
    for (const marker of ["```", "~~~~~"]) {
      const text = `Intro\n${marker}typescript\nalpha\nbeta\n${marker}\nAfter`
      for (const cut of [text.indexOf(marker) + 1, text.indexOf("typescript") + 4, text.lastIndexOf(marker) + 1]) {
        const result = pages(text, cut)
        assert.equal(result.map(page => page.sourceText).join(""), text)
        assert.equal(result[0].markdownText, null)
        assert.equal(result[1].markdownText, null)
      }
    }
  })

  it("does not silently consume incidental closing-looking fragments", () => {
    const text = "```text\nxxx```\nafter\n```\n"
    const cut = text.indexOf("xxx") + 3
    assert.equal(missionMarkdownPage(text, 1, cut).markdownText, null)
    const truncated = "```text\n```not a closer\nlast\n```\n"
    assert.equal(missionMarkdownPage(truncated, 0, truncated.indexOf("not")).markdownText, null)
  })

  it("recognizes longer closers, wrong marker bodies and invalid backtick info", () => {
    const text = "```js\n" + "~~~\nbody\n".repeat(50) + "`````  \t\n\nAfter"
    const result = pages(text, 100)
    assert.equal(result.map(page => page.sourceText).join(""), text)
    assert.ok(result.some(page => page.markdownText?.startsWith("```js\n~~~")))
    assert.match(result.at(-1)!.markdownText!, /After$/)
    const invalid = "```has`backtick\n" + "ordinary prose\n".repeat(10)
    assert.equal(missionMarkdownPage(invalid, 1, 50).markdownText, invalid.slice(50, 100))
  })

  it("tracks different fences through mixed code/prose pages and distant original prefixes", () => {
    const text = "```js\n" + "first\n".repeat(2_000) + "```\n\n**Between**\n\n~~~html\n"
      + "second\n".repeat(3_000) + "~~~\n\n**After**"
    const result = pages(text)
    assert.equal(result.map(page => page.sourceText).join(""), text)
    assert.ok(result[1].markdownText?.startsWith("```js\n"))
    assert.ok(result[1].markdownText?.endsWith("~~~\n"))
    assert.ok(result[2].markdownText?.startsWith("~~~html\n"))
    assert.match(marked.parse(result[1].markdownText!) as string, /<strong>Between<\/strong>/)
    assert.match(marked.parse(result.at(-1)!.markdownText!) as string, /<strong>After<\/strong>/)
  })

  it("handles complete fence boundaries, CRLF and originally unclosed fences", () => {
    const text = "~~~js\r\n" + "value\r\n".repeat(5_000)
    for (const size of [7, 100, 9_000]) {
      const result = pages(text, size)
      assert.equal(result.map(page => page.sourceText).join(""), text)
      for (const page of result) {
        assert.notEqual(page.markdownText, null)
        assert.ok(page.markdownText!.length <= page.sourceText.length + 115)
        assert.ok(marked.lexer(page.markdownText!).some(token => token.type === "code"))
      }
    }
    const openerOnly = missionMarkdownPage("~~~js\nvalue\n~~~\n", 0, 5)
    assert.equal(openerOnly.sourceText, "~~~js")
    assert.equal(openerOnly.markdownText, "~~~js\n~~~\n")
  })

  it("supports up to three spaces of fence indentation without adding indentation to source", () => {
    for (const indent of ["", " ", "   "]) {
      const text = `${indent}~~~python\n` + "  original indentation\n".repeat(1_000) + `${indent}~~~\nAfter`
      const page = missionMarkdownPage(text, 1)
      assert.ok(page.markdownText?.startsWith("~~~python\n"))
      assert.equal(page.sourceText, text.slice(9_000, 18_000))
      assert.ok(codeText(page.markdownText!).includes("  original indentation"))
    }
    const indented = "    ```text\n" + "prose\n".repeat(50)
    assert.equal(missionMarkdownPage(indented, 1, 100).markdownText, indented.slice(100, 200))
  })

  it("caps synthetic language metadata, never injects hostile info strings", () => {
    for (const language of ["x".repeat(50_000), '<img/src=x onerror=alert(1)>', "&quot;", "bad~language"]) {
      const text = `~~~${language}\n` + "value\n".repeat(5_000)
      const pageNumber = Math.ceil((language.length + 4) / 9_000) + 1
      const page = missionMarkdownPage(text, pageNumber)
      assert.ok(page.markdownText?.startsWith("~~~\n"))
      assert.ok(page.markdownText!.length < 10_000)
      assert.equal(page.sourceText, text.slice(pageNumber * 9_000, (pageNumber + 1) * 9_000))
    }
    const text = "~~~" + "a".repeat(48) + " other metadata\n" + "value\n".repeat(5_000)
    assert.ok(missionMarkdownPage(text, 1).markdownText?.startsWith("~~~" + "a".repeat(48) + "\n"))
  })

  it("fails safely for huge fence delimiters without copying their length into metadata", () => {
    for (const marker of ["`", "~"]) {
      const fence = marker.repeat(20_000)
      const text = `${fence}\n` + "value\n".repeat(5_000) + `${fence}\nAfter`
      const result = pages(text)
      assert.equal(result.map(page => page.sourceText).join(""), text)
      assert.equal(result[0].markdownText, null)
      assert.equal(result[3].markdownText, null)
      for (const page of result) assert.ok(page.markdownText === null || page.markdownText.length < 10_000)
    }
  })

  it("stays below the shared render cap with maximum metadata and surrogate adjustment", () => {
    const fence = "~".repeat(32), language = "x".repeat(48)
    const prefix = `${fence}${language}\n`
    const text = prefix + "a".repeat(9_000 - prefix.length - 1) + "😀" + "a".repeat(20_000)
    const result = pages(text)
    assert.equal(result.map(page => page.sourceText).join(""), text)
    for (const page of result) {
      assert.ok(page.markdownText !== null)
      assert.ok(page.markdownText.length <= page.sourceText.length + 115)
      assert.ok(page.markdownText.length < 10_000)
      // The parser may add/remove a terminal newline, but synthetic context is
      // never counted as source/evidence and adds no code payload or extra prose.
      assert.ok(codeText(page.markdownText).length <= page.sourceText.length + 1)
    }
  })

  it("leaves HTML/entity escaping to the real shared renderer", async () => {
    const hostile = '<img/src=x onerror=alert(1)>&lt;source&gt;'
    const text = "~~~html\n" + `${hostile}\n`.repeat(500) + "~~~\n\n<script>alert(1)</script>"
    const page = missionMarkdownPage(text, 1)
    const html = await renderMarkdown(page.markdownText!, { suppressHighlight: true, escapeRawHtml: true, literalRawHtml: true })
    assert.doesNotMatch(html, /<img|<script>/)
    assert.match(html, /&lt;img\/src=x onerror=alert\(1\)>/)
    assert.match(html, /&amp;lt;source&amp;gt;/)
    const prose = missionMarkdownPage("<script>alert(1)</script>\n\n**visible**", 0)
    const rendered = await renderMarkdown(prose.markdownText!, { suppressHighlight: true, escapeRawHtml: true, literalRawHtml: true })
    assert.doesNotMatch(rendered, /<script>/)
    assert.match(rendered, /<strong>visible<\/strong>/)
  })

  it("rejects unsafe page inputs rather than silently truncating requested pages", () => {
    for (const page of [-1, 0.5, NaN, Infinity]) assert.throws(() => missionMarkdownPage("text", page), RangeError)
    for (const size of [0, -1, 9_001, 1.5, NaN, Infinity]) assert.throws(() => missionMarkdownPage("text", 0, size), RangeError)
  })
})
