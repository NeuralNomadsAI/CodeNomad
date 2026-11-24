import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createTextAttachment } from "../types/attachment.ts"
import {
  clearInstanceAttachmentValues,
  clearInstanceAttachments,
  getAuthoritativeAttachmentSessionIdsForInstance,
  getAttachments,
  getSessionAttachmentsForInstance,
  hydrateSessionAttachments,
  removeAttachment,
} from "./attachments.ts"

describe("attachment hydration", () => {
  it("hydrates and captures attachments by instance and session", () => {
    const attachment = createTextAttachment("restored text", "pasted #1 (4 lines)", "paste-1.txt")
    hydrateSessionAttachments("restore-instance", "session-1", [attachment])

    assert.deepEqual(getAttachments("restore-instance", "session-1"), [attachment])
    assert.deepEqual(getSessionAttachmentsForInstance("restore-instance"), { "session-1": [attachment] })

    clearInstanceAttachments("restore-instance")
    assert.deepEqual(getSessionAttachmentsForInstance("restore-instance"), {})
  })

  it("records an authoritative tombstone when the last attachment is removed", () => {
    const instanceId = "removed-last-attachment-instance"
    const sessionId = "session-1"
    const attachment = createTextAttachment("restored text", "pasted #1 (4 lines)", "paste-1.txt")
    hydrateSessionAttachments(instanceId, sessionId, [attachment])

    assert.equal(getAuthoritativeAttachmentSessionIdsForInstance(instanceId).has(sessionId), false)
    removeAttachment(instanceId, sessionId, attachment.id)

    assert.deepEqual(getSessionAttachmentsForInstance(instanceId), {})
    assert.equal(getAuthoritativeAttachmentSessionIdsForInstance(instanceId).has(sessionId), true)

    clearInstanceAttachmentValues(instanceId)
    assert.equal(getAuthoritativeAttachmentSessionIdsForInstance(instanceId).has(sessionId), true)

    clearInstanceAttachments(instanceId)
    assert.equal(getAuthoritativeAttachmentSessionIdsForInstance(instanceId).has(sessionId), false)
  })
})
