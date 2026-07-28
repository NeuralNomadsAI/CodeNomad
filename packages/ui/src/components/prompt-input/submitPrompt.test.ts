import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createTextAttachment } from "../../types/attachment"
import { prepareFailedPromptRecovery, preparePromptSubmission } from "./submitPrompt"

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

describe("prepareFailedPromptRecovery", () => {
  it("remaps colliding pasted placeholders without losing either value", () => {
    const oldPaste = { ...createTextAttachment("OLD", "pasted #1", "old.txt"), id: "old" }
    const newPaste = { ...createTextAttachment("NEW", "pasted #1", "new.txt"), id: "new" }
    const recovered = prepareFailedPromptRecovery({
      submittedText: "[pasted #1]",
      submittedAttachments: [oldPaste],
      currentText: "[pasted #1]",
      currentAttachments: [newPaste],
    })
    assert.equal(recovered.text, "[pasted #2]\n[pasted #1]")
    assert.deepEqual(recovered.attachments.map((attachment) => attachment.display), ["pasted #1", "pasted #2"])
  })
  it("does not cascade counter replacements across multiple recovered pastes", () => {
    const recovered = prepareFailedPromptRecovery({
      submittedText: "[pasted #1] [pasted #2]",
      submittedAttachments: [
        { ...createTextAttachment("ONE", "pasted #1", "one.txt"), id: "old-1" },
        { ...createTextAttachment("TWO", "pasted #2", "two.txt"), id: "old-2" },
      ],
      currentText: "[pasted #1] [pasted #2]",
      currentAttachments: [
        { ...createTextAttachment("NEW ONE", "pasted #1", "new-one.txt"), id: "new-1" },
        { ...createTextAttachment("NEW TWO", "pasted #2", "new-two.txt"), id: "new-2" },
      ],
    })
    assert.equal(recovered.text, "[pasted #3] [pasted #4]\n[pasted #1] [pasted #2]")
  })
})
