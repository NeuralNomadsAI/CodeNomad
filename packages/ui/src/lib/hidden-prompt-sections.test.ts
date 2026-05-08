import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { preparePromptDisplayText, splitHiddenPromptSections } from "./hidden-prompt-sections"

describe("preparePromptDisplayText", () => {
  it("strips wrapped hidden markers before sending while preserving display text", () => {
    const result = preparePromptDisplayText("Visible\n<codenomad:hide>Hidden\nPlan</codenomad:hide>\nDone")

    assert.equal(result.promptToSend, "Visible\nHidden\nPlan\nDone")
    assert.equal(result.displayText, "Visible\n<codenomad:hide>Hidden\nPlan</codenomad:hide>\nDone")
  })

  it("leaves prompts without markers unchanged", () => {
    const result = preparePromptDisplayText("Visible only")

    assert.equal(result.promptToSend, "Visible only")
    assert.equal(result.displayText, undefined)
  })
})

describe("splitHiddenPromptSections", () => {
  it("splits wrapped hidden prompt sections", () => {
    assert.deepEqual(splitHiddenPromptSections("Intro<codenomad:hide>Secret</codenomad:hide>Outro"), [
      { hidden: false, text: "Intro" },
      { hidden: true, text: "Secret" },
      { hidden: false, text: "Outro" },
    ])
  })

  it("supports explicit start/end hide markers", () => {
    assert.deepEqual(splitHiddenPromptSections("Intro<codenomad:start-hide />Secret<codenomad:end-hide />Outro"), [
      { hidden: false, text: "Intro" },
      { hidden: true, text: "Secret" },
      { hidden: false, text: "Outro" },
    ])
  })

  it("falls back to visible text when a hide section is left unclosed", () => {
    assert.deepEqual(splitHiddenPromptSections("Intro<codenomad:hide>Secret"), [
      { hidden: false, text: "Intro<codenomad:hide>Secret" },
    ])
  })
})
