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
    const inlineDollar = await renderMarkdown(String.raw`$\[x\]$`, { suppressHighlight: true })
    const displayDollar = await renderMarkdown(String.raw`$$\[x\]$$`, { suppressHighlight: true })

    assert.equal(code, '<p><code class="inline-code">\\[x\\]</code></p>\n')
    assert.equal(multilineCode, '<p><code class="inline-code">a \\[x\\]</code></p>\n')
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
})
