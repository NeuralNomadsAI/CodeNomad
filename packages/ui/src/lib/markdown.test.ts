import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { renderMarkdown } from "./markdown"

describe("renderMarkdown bracket math delimiters", () => {
  it("renders inline bracket math", async () => {
    const html = await renderMarkdown(String.raw`\(x^2\)`, { suppressHighlight: true })

    assert.match(html, /<span class="katex">/)
    assert.match(html, /x/)
  })

  it("renders multiline display bracket math", async () => {
    const html = await renderMarkdown(String.raw`\[x^
2\]`, { suppressHighlight: true })

    assert.match(html, /<span class="katex-display">/)
  })

  it("splits prose around adjacent single-line and multiline display math", async () => {
    const singleLine = await renderMarkdown("before\n\\[x^2\\]\nafter", { suppressHighlight: true })
    const multiline = await renderMarkdown("before\n\\[\nx^2\n\\]\nafter", { suppressHighlight: true })

    for (const html of [singleLine, multiline]) {
      assert.match(html, /^<p>before<\/p>\n<span class="katex-display">/)
      assert.match(html, /<p>after<\/p>\n$/)
      assert.doesNotMatch(html, /<br>/)
      assert.doesNotMatch(html, /katex-error/)
    }
  })

  it("preserves dollar-delimited math", async () => {
    const inline = await renderMarkdown("$x^2$", { suppressHighlight: true })
    const display = await renderMarkdown("$$x^2$$", { suppressHighlight: true })

    assert.match(inline, /<span class="katex">/)
    assert.match(display, /<span class="katex-display">/)
  })

  it("leaves bracket delimiters literal in code", async () => {
    const inline = await renderMarkdown("`\\(x^2\\)`", { suppressHighlight: true })
    const fenced = await renderMarkdown("```text\n\\[x^2\\]\n```", { suppressHighlight: true })

    assert.doesNotMatch(inline, /class="katex/)
    assert.match(inline, /\\\(x\^2\\\)/)
    assert.doesNotMatch(fenced, /class="katex/)
    assert.match(fenced, /\\\[x\^2\\\]/)
  })

  it("does not split incomplete or empty display delimiters", async () => {
    const empty = await renderMarkdown(String.raw`a \[\] b`, { suppressHighlight: true })
    const unmatched = await renderMarkdown(String.raw`a \[x`, { suppressHighlight: true })

    assert.equal(empty, "<p>a [] b</p>\n")
    assert.equal(unmatched, "<p>a [x</p>\n")
  })

  it("does not hijack bracket delimiters in inline code or dollar math", async () => {
    const code = await renderMarkdown("`\\[x\\]`", { suppressHighlight: true })
    const multilineCode = await renderMarkdown("`a\n\\[x\\]`", { suppressHighlight: true })
    const multilineDoubleCode = await renderMarkdown("``a\n\\[x\\]``", { suppressHighlight: true })
    const escapedBackticks = await renderMarkdown("\\`a\n\\[x\\]\nafter\\`", { suppressHighlight: true })
    const inlineDollar = await renderMarkdown(String.raw`$\[x\]$`, { suppressHighlight: true })
    const displayDollar = await renderMarkdown(String.raw`$$\[x\]$$`, { suppressHighlight: true })

    assert.equal(code, '<p><code class="inline-code">\\[x\\]</code></p>\n')
    assert.equal(multilineCode, '<p><code class="inline-code">a \\[x\\]</code></p>\n')
    assert.equal(multilineDoubleCode, '<p><code class="inline-code">a \\[x\\]</code></p>\n')
    assert.match(escapedBackticks, /<span class="katex-display">/)
    assert.doesNotMatch(escapedBackticks, /katex-error/)
    assert.match(inlineDollar, /^<p><span class="katex-error"/)
    assert.doesNotMatch(inlineDollar, /katex-display/)
    assert.match(displayDollar, /^<p><span class="katex-error"/)
  })

  it("renders bracket display math after dollar display or bare dollars", async () => {
    const afterDollarDisplay = await renderMarkdown("$$\nx\n$$\n\n\\[y\\]", { suppressHighlight: true })
    const afterBareDollars = await renderMarkdown("plain $$\n\n\\[x\\]", { suppressHighlight: true })

    assert.equal((afterDollarDisplay.match(/class="katex-display"/g) ?? []).length, 2)
    assert.match(afterBareDollars, /class="katex-display"/)
    assert.doesNotMatch(afterBareDollars, /<br>/)
  })

  it("leaves escaped, empty, and unmatched bracket delimiters literal", async () => {
    const html = await renderMarkdown(String.raw`\\(x^2\) \\[x^2\] \(\) \[\] \(x^2 \[x^2`, {
      suppressHighlight: true,
    })

    assert.doesNotMatch(html, /class="katex/)
    assert.match(html, /\\\(x\^2\\\)/)
    assert.match(html, /\\\[x\^2\]/)
  })

  it("leaves line-start and mid-paragraph invalid display delimiters literal", async () => {
    const html = await renderMarkdown("\\\\[x\\]\n\\[\]\n\\[x\na \\[\] b\na \\[x", { suppressHighlight: true })

    assert.doesNotMatch(html, /class="katex/)
    assert.doesNotMatch(html, /katex-error/)
  })

  it("does not split paragraphs for whitespace-only display delimiters", async () => {
    const singleLine = await renderMarkdown("before\n\\[   \\]\nafter", { suppressHighlight: true })
    const multiline = await renderMarkdown("before\n\\[\n \t\n\\]\nafter", { suppressHighlight: true })

    for (const html of [singleLine, multiline]) {
      assert.doesNotMatch(html, /class="katex/)
      assert.doesNotMatch(html, /katex-error/)
      assert.match(html, /^<p>before<br>/)
      assert.match(html, /after<\/p>\n$/)
    }
  })
})

describe("renderMarkdown raw HTML", () => {
  it("preserves text after style tags inside malformed inline code", async () => {
    const content = [
      "- evidence: [source] `return ",
      '`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${options.styles.join(";")}</style></head>',
      '<body>${options.html}</body></html>`;` - and the test remains visible',
    ].join("")

    const html = await renderMarkdown(content, { suppressHighlight: true, escapeRawHtml: true })

    assert.doesNotMatch(html, /<style>/)
    assert.match(html, /and the test remains visible/)
  })
})
