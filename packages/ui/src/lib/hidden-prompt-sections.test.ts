import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { preparePromptDisplayText, splitHiddenPromptSections } from "./hidden-prompt-sections"

describe("preparePromptDisplayText", () => {
  it("strips wrapped hidden markers before sending while preserving display metadata", () => {
    const result = preparePromptDisplayText("Visible\n<codenomad:hide>Hidden\nPlan</codenomad:hide>\nDone")

    assert.equal(result.promptToSend, "Visible\nHidden\nPlan\nDone")
    assert.deepEqual(result.displayMetadata, {
      segments: [
        { hidden: false, length: 8 },
        { hidden: true, length: 11 },
        { hidden: false, length: 5 },
      ],
    })
  })

  it("leaves prompts without markers unchanged", () => {
    const result = preparePromptDisplayText("Visible only")

    assert.equal(result.promptToSend, "Visible only")
    assert.equal(result.displayMetadata, undefined)
  })

  it("treats malformed markers as plain text for both display and send", () => {
    const result = preparePromptDisplayText("Intro<codenomad:hide>Secret")

    assert.equal(result.promptToSend, "Intro<codenomad:hide>Secret")
    assert.equal(result.displayMetadata, undefined)
  })
})

describe("splitHiddenPromptSections", () => {
  const wrapped = preparePromptDisplayText("Intro<codenomad:hide>Secret</codenomad:hide>Outro")

  it("splits wrapped hidden prompt sections", () => {
    assert.deepEqual(splitHiddenPromptSections(wrapped.promptToSend, wrapped.displayMetadata), [
      { hidden: false, text: "Intro" },
      { hidden: true, text: "Secret" },
      { hidden: false, text: "Outro" },
    ])
  })

  it("supports explicit start/end hide markers", () => {
    const result = preparePromptDisplayText("Intro<codenomad:start-hide />Secret<codenomad:end-hide />Outro")

    assert.deepEqual(splitHiddenPromptSections(result.promptToSend, result.displayMetadata), [
      { hidden: false, text: "Intro" },
      { hidden: true, text: "Secret" },
      { hidden: false, text: "Outro" },
    ])
  })

  it("returns null when metadata does not match the text", () => {
    assert.equal(splitHiddenPromptSections("Too short", wrapped.displayMetadata), null)
  })
})
