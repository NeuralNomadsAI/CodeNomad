import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createFileAttachment, createTextAttachment } from "../types/attachment"
import { formatFencedCode, preparePromptDisplayText, resolvePastedPlaceholders, splitPromptDisplaySections } from "./prompt-display-metadata"

describe("preparePromptDisplayText", () => {
  it("resolves every root mention without changing parent paths or literal marker text", () => {
    const prompt = "@./a @./b @. @. @.. @../c ___ROOT___ ___ROOT_NOSLASH___"
    const expected = "./a ./b ./ ./ @.. @../c ___ROOT___ ___ROOT_NOSLASH___"
    const attachments = [createFileAttachment("./a", "a"), createTextAttachment(".", "path:.", ".")]

    assert.equal(resolvePastedPlaceholders(prompt, attachments), expected)
    assert.equal(preparePromptDisplayText(prompt, attachments).promptToSend, expected)
  })

  it("preserves pasted text and display sections alongside repeated root mentions", () => {
    const pasted = "@./verbatim ___ROOT___ ___ROOT_NOSLASH___"
    const attachment = createTextAttachment(pasted, "pasted #1", "paste-1.txt")
    const prompt = "@./a @./b\n[pasted #1]\n@. @."
    const prepared = preparePromptDisplayText(prompt, [attachment])

    assert.equal(prepared.promptToSend, `./a ./b\n${pasted}\n./ ./`)
    assert.equal(resolvePastedPlaceholders(prompt, [attachment]), prepared.promptToSend)
    assert.deepEqual(splitPromptDisplaySections(prepared.promptToSend, prepared.displayMetadata), [
      { kind: "inline", text: "./a ./b\n" },
      { kind: "pasted", text: pasted },
      { kind: "inline", text: "\n./ ./" },
    ])
  })

  it("keeps pasted text fully visible to the model while storing display metadata", () => {
    const attachment = createTextAttachment("line 1\nline 2\nline 3\nline 4", "pasted #1 (4 lines)", "paste-1.txt")

    const result = preparePromptDisplayText("Summarize this:\n[pasted #1]\nThanks", [attachment])

    assert.equal(result.promptToSend, "Summarize this:\nline 1\nline 2\nline 3\nline 4\nThanks")
    assert.deepEqual(result.displayMetadata, {
      segments: [
        { kind: "inline", length: 16 },
        { kind: "pasted", length: 27 },
        { kind: "inline", length: 7 },
      ],
    })
  })

  it("falls back to plain text rendering when no placeholder-backed pasted structure remains", () => {
    const pastedText = "line 1\nline 2\nline 3\nline 4"
    const attachment = createTextAttachment(pastedText, "pasted #1 (4 lines)", "paste-1.txt")

    const result = preparePromptDisplayText(`Summarize this:\n${pastedText}\nThanks`, [attachment])

    assert.equal(result.promptToSend, `Summarize this:\n${pastedText}\nThanks`)
    assert.equal(result.displayMetadata, undefined)
  })

  it("resolves loose pasted placeholders consistently", () => {
    const attachment = createTextAttachment("alpha\nbeta\ngamma\ndelta", "pasted #1 (4 lines)", "paste-1.txt")

    assert.equal(resolvePastedPlaceholders("Before [ pasted # 1 ] After", [attachment]), "Before alpha\nbeta\ngamma\ndelta After")
  })

  it("resolves pasted placeholders when the placeholder casing is edited", () => {
    const attachment = createTextAttachment("alpha\nbeta\ngamma\ndelta", "pasted #1 (4 lines)", "paste-1.txt")

    const result = preparePromptDisplayText("Before [Pasted #1] After", [attachment])

    assert.equal(result.promptToSend, "Before alpha\nbeta\ngamma\ndelta After")
    assert.deepEqual(result.displayMetadata, {
      segments: [
        { kind: "inline", length: 7 },
        { kind: "pasted", length: 22 },
        { kind: "inline", length: 6 },
      ],
    })
  })

  it("normalizes pasted CRLF content so collapsed metadata survives LF hydration", () => {
    const attachment = createTextAttachment("a\r\nb\r\nc\r\nd", "pasted #1 (4 lines)", "paste-1.txt")

    const prepared = preparePromptDisplayText("Intro\n[pasted #1]\nOutro", [attachment])

    assert.equal(prepared.promptToSend, "Intro\na\nb\nc\nd\nOutro")
    assert.deepEqual(splitPromptDisplaySections("Intro\na\nb\nc\nd\nOutro", prepared.displayMetadata), [
      { kind: "inline", text: "Intro\n" },
      { kind: "pasted", text: "a\nb\nc\nd" },
      { kind: "inline", text: "\nOutro" },
    ])
  })
})

describe("splitPromptDisplaySections", () => {
  it("reconstructs inline and pasted display sections", () => {
    const attachment = createTextAttachment("A\nB\nC\nD", "pasted #1 (4 lines)", "paste-1.txt")
    const prepared = preparePromptDisplayText("Intro\n[pasted #1]\nOutro", [attachment])

    assert.deepEqual(splitPromptDisplaySections(prepared.promptToSend, prepared.displayMetadata), [
      { kind: "inline", text: "Intro\n" },
      { kind: "pasted", text: "A\nB\nC\nD" },
      { kind: "inline", text: "\nOutro" },
    ])
  })

  const paste = (value: string, counter = 1) => createTextAttachment(value, `pasted #${counter} (lines)`, `paste-${counter}.txt`)
  const sections = (prompt: string, attachments: ReturnType<typeof paste>[]) => {
    const prepared = preparePromptDisplayText(prompt, attachments)
    return { sent: prepared.promptToSend, sections: splitPromptDisplaySections(prepared.promptToSend, prepared.displayMetadata) }
  }

  const fenced = (code: string, marker = "```", info = "") => ({ kind: "pasted", text: code, codeFence: { marker, info } })

  it("renders a paste typed between fences as one fenced pasted section and sends it once inside the fences", () => {
    const result = sections("Scalar fails:\n```\n[pasted #1]\n```\nWhy?", [paste("a\nb\nc\nd")])

    assert.equal(result.sent, "Scalar fails:\n```\na\nb\nc\nd\n```\nWhy?")
    assert.deepEqual(result.sections, [
      { kind: "inline", text: "Scalar fails:\n" },
      fenced("a\nb\nc\nd"),
      { kind: "inline", text: "\nWhy?" },
    ])
  })

  it("keeps language tags, tilde fences and in-fence text in the fenced section", () => {
    const json = sections("```json\n[pasted #1]\n```", [paste('{\n  "a": 1\n}')])
    assert.deepEqual(json.sections, [fenced('{\n  "a": 1\n}', "```", "json")])

    const tilde = sections("~~~\n// header\n[pasted #1]\n// footer\n~~~", [paste("x\ny\nz\nw")])
    assert.deepEqual(tilde.sections, [fenced("// header\nx\ny\nz\nw\n// footer", "~~~")])
  })

  it("groups several pastes in one fence and keeps a paste outside fences on its own", () => {
    const result = sections("[pasted #1]\n```\n[pasted #2]\n---\n[pasted #3]\n```", [
      paste("o\nu\nt\ns", 1), paste("1\n2\n3\n4", 2), paste("5\n6\n7\n8", 3),
    ])

    assert.equal(result.sent, "o\nu\nt\ns\n```\n1\n2\n3\n4\n---\n5\n6\n7\n8\n```")
    assert.deepEqual(result.sections, [
      { kind: "pasted", text: "o\nu\nt\ns" },
      { kind: "inline", text: "\n" },
      fenced("1\n2\n3\n4\n---\n5\n6\n7\n8"),
    ])
  })

  it("runs an unclosed fence to the end and ignores fences inside pasted text", () => {
    const unclosed = sections("Log:\n```\n[pasted #1]", [paste("l1\nl2\nl3\nl4")])
    assert.deepEqual(unclosed.sections, [{ kind: "inline", text: "Log:\n" }, fenced("l1\nl2\nl3\nl4")])

    const fencedPaste = "```\ncode\n```\nprose"
    const outside = sections("Intro\n[pasted #1]\n```\nafter", [paste(fencedPaste)])
    assert.deepEqual(outside.sections, [
      { kind: "inline", text: "Intro\n" },
      { kind: "pasted", text: fencedPaste },
      { kind: "inline", text: "\n```\nafter" },
    ])
  })

  it("ends a paste ending in a line break before the closing fence typed after it", () => {
    const result = sections("```json\n[pasted #1]```\nAfter", [paste("a\nb\nc\nd\n")])

    assert.equal(result.sent, "```json\na\nb\nc\nd\n```\nAfter")
    assert.deepEqual(result.sections, [fenced("a\nb\nc\nd", "```", "json"), { kind: "inline", text: "\nAfter" }])
  })

  it("fences displayed code with a fence longer than any run inside it", () => {
    const backticks = sections("```\n[pasted #1]\n```", [paste("first\n```\nlast\n`````\nline")])
    assert.deepEqual(backticks.sections, [fenced("first\n```\nlast\n`````\nline")])
    assert.equal(formatFencedCode({ marker: "```", info: "" }, "first\n```\nlast\n`````\nline"),
      "``````\nfirst\n```\nlast\n`````\nline\n``````")

    const tildes = sections("~~~~ md\n[pasted #1]\n~~~~", [paste("a\n~~~~~~\nb\n```\nc")])
    assert.deepEqual(tildes.sections, [fenced("a\n~~~~~~\nb\n```\nc", "~~~~", " md")])
    assert.equal(formatFencedCode({ marker: "~~~~", info: " md" }, "a\n~~~~~~\nb\n```\nc"),
      "~~~~~~~ md\na\n~~~~~~\nb\n```\nc\n~~~~~~~")
  })

  it("keeps a very long pasted fence run out of the displayed source until its window shows it", () => {
    for (const run of ["`".repeat(20_000), "~".repeat(60_000)]) {
      const code = `first\n${run}\nlast`
      const result = sections("```\n[pasted #1]\n```", [paste(code)])
      // The section holds only the code: display bounds slice code, never a generated fence.
      assert.deepEqual(result.sections, [fenced(code)])
      const window = code.slice(0, 5_000)
      const formatted = formatFencedCode({ marker: "```", info: "" }, window)
      const fence = run[0] === "`" ? "`".repeat(5_000 - 6 + 1) : "```"
      assert.equal(formatted, `${fence}\n${window}\n${fence}`)
    }
  })

  it("closes fences only on space or tab suffixes", () => {
    const result = sections("```\n[pasted #1]\n``` \nAfter\n``` \t\nOut", [paste("a\nb\nc\nd")])
    assert.deepEqual(result.sections, [fenced("a\nb\nc\nd\n``` \nAfter"), { kind: "inline", text: "\nOut" }])
  })

  it("excludes the CRLF before the closing fence from the copied code", () => {
    const result = sections("```json\r\n[pasted #1]\r\n```\r\nAfter", [paste("a\nb\nc\nd")])
    assert.deepEqual(result.sections, [fenced("a\nb\nc\nd", "```", "json"), { kind: "inline", text: "\nAfter" }])
  })

  it("leaves fences without pasted text inline", () => {
    const result = sections("```\nown code\n```\n[pasted #1]", [paste("p\nq\nr\ns")])
    assert.deepEqual(result.sections, [
      { kind: "inline", text: "```\nown code\n```\n" },
      { kind: "pasted", text: "p\nq\nr\ns" },
    ])
  })

  it("returns null when metadata no longer matches the text", () => {
    assert.equal(
      splitPromptDisplaySections("short", { segments: [{ kind: "inline", length: 10 }] }),
      null,
    )
  })
})
