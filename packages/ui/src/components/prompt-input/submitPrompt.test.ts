import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createTextAttachment } from "../../types/attachment"
import { preparePromptSubmission, resolvePromptDelivery } from "./submitPrompt"

describe("resolvePromptDelivery", () => {
  it("uses steer at rest and flips the configured delivery for the busy-session alternate shortcut", () => {
    assert.equal(resolvePromptDelivery(false, "queue"), "steer")
    assert.equal(resolvePromptDelivery(true, "steer"), "steer")
    assert.equal(resolvePromptDelivery(true, "steer", true), "queue")
    assert.equal(resolvePromptDelivery(true, "queue"), "queue")
    assert.equal(resolvePromptDelivery(true, "queue", true), "steer")
  })
})

describe("preparePromptSubmission", () => {
  it("keeps placeholder-backed pasted text intact for message submission while resolving history text", () => {
    const attachment = createTextAttachment("alpha\nbeta\ngamma\ndelta", "pasted #1 (4 lines)", "paste-1.txt")

    const result = preparePromptSubmission({
      mode: "message",
      text: "Intro\n[pasted #1]\nOutro",
      attachments: [attachment],
    })

    assert.equal(result.submitPrompt, "Intro\n[pasted #1]\nOutro")
    assert.equal(result.historyEntry, "Intro\nalpha\nbeta\ngamma\ndelta\nOutro")
  })
})
