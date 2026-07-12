import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createTextAttachment } from "../../types/attachment"
import { preparePromptSubmission } from "./submitPrompt"

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
