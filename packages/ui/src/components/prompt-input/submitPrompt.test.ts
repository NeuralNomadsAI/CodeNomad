import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createTextAttachment } from "../../types/attachment"
import { OpencodeApiError, requestData } from "../../lib/opencode-api"
import { prepareFailedPromptRecovery, preparePromptSubmission, shouldSuppressFailedPromptRecovery } from "./submitPrompt"

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

describe("shouldSuppressFailedPromptRecovery", () => {
  it("recovers definite local and HTTP failures", async () => {
    assert.equal(shouldSuppressFailedPromptRecovery(new Error("Instance not ready")), false)
    const failure = await requestData(
      Promise.resolve({ error: { message: "Bad command" }, response: { status: 400 } }) as any,
      "session.command",
    ).catch((error) => error)
    assert.equal(shouldSuppressFailedPromptRecovery(failure), false)
  })

  it("suppresses recovery only when the delivery-aware action marks the error", async () => {
    const ambiguous = new OpencodeApiError("shell failed", { cause: new TypeError("Failed to fetch") })
    assert.equal(shouldSuppressFailedPromptRecovery(ambiguous), false)
    ;(ambiguous as any).suppressPromptRecovery = true
    assert.equal(shouldSuppressFailedPromptRecovery(ambiguous), true)
    const failure = await requestData(
      Promise.resolve({ error: { message: "Gateway failed" }, response: { status: 502 } }) as any,
      "session.command",
    ).catch((error) => error)
    assert.equal(shouldSuppressFailedPromptRecovery(failure), false)
  })
})
