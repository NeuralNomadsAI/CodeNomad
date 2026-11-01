import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createFileAttachment, createTextAttachment } from "../types/attachment"
import { preparePromptDisplayText, resolvePastedPlaceholders, splitPromptDisplaySections } from "./prompt-display-metadata"

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

  it("renders a paste typed between fences as one fenced pasted section and sends it once inside the fences", () => {
    const result = sections("Scalar fails:\n```\n[pasted #1]\n```\nWhy?", [paste("a\nb\nc\nd")])

    assert.equal(result.sent, "Scalar fails:\n```\na\nb\nc\nd\n```\nWhy?")
    assert.deepEqual(result.sections, [
      { kind: "inline", text: "Scalar fails:\n" },
      { kind: "pasted", text: "```\na\nb\nc\nd\n```", content: "a\nb\nc\nd" },
      { kind: "inline", text: "\nWhy?" },
    ])
  })

  it("keeps language tags, tilde fences and in-fence text in the fenced section", () => {
    const json = sections("```json\n[pasted #1]\n```", [paste('{\n  "a": 1\n}')])
    assert.deepEqual(json.sections, [
      { kind: "pasted", text: '```json\n{\n  "a": 1\n}\n```', content: '{\n  "a": 1\n}' },
    ])

    const tilde = sections("~~~\n// header\n[pasted #1]\n// footer\n~~~", [paste("x\ny\nz\nw")])
    assert.deepEqual(tilde.sections, [
      { kind: "pasted", text: "~~~\n// header\nx\ny\nz\nw\n// footer\n~~~", content: "// header\nx\ny\nz\nw\n// footer" },
    ])
  })

  it("groups several pastes in one fence and keeps a paste outside fences on its own", () => {
    const result = sections("[pasted #1]\n```\n[pasted #2]\n---\n[pasted #3]\n```", [
      paste("o\nu\nt\ns", 1), paste("1\n2\n3\n4", 2), paste("5\n6\n7\n8", 3),
    ])

    assert.equal(result.sent, "o\nu\nt\ns\n```\n1\n2\n3\n4\n---\n5\n6\n7\n8\n```")
    assert.deepEqual(result.sections, [
      { kind: "pasted", text: "o\nu\nt\ns" },
      { kind: "inline", text: "\n" },
      { kind: "pasted", text: "```\n1\n2\n3\n4\n---\n5\n6\n7\n8\n```", content: "1\n2\n3\n4\n---\n5\n6\n7\n8" },
    ])
  })

  it("runs an unclosed fence to the end and ignores fences inside pasted text", () => {
    const unclosed = sections("Log:\n```\n[pasted #1]", [paste("l1\nl2\nl3\nl4")])
    assert.deepEqual(unclosed.sections, [
      { kind: "inline", text: "Log:\n" },
      { kind: "pasted", text: "```\nl1\nl2\nl3\nl4", content: "l1\nl2\nl3\nl4" },
    ])

    const fencedPaste = "```\ncode\n```\nprose"
    const outside = sections("Intro\n[pasted #1]\n```\nafter", [paste(fencedPaste)])
    assert.deepEqual(outside.sections, [
      { kind: "inline", text: "Intro\n" },
      { kind: "pasted", text: fencedPaste },
      { kind: "inline", text: "\n```\nafter" },
    ])
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
