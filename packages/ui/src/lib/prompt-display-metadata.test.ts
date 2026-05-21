import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createTextAttachment } from "../types/attachment"
import { preparePromptDisplayText, resolvePastedPlaceholders, splitPromptDisplaySections } from "./prompt-display-metadata"

describe("preparePromptDisplayText", () => {
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

  it("returns null when metadata no longer matches the text", () => {
    assert.equal(
      splitPromptDisplaySections("short", { segments: [{ kind: "inline", length: 10 }] }),
      null,
    )
  })
})
