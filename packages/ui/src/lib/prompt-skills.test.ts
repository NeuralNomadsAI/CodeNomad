import assert from "node:assert/strict"
import { test } from "node:test"
import { createSkillAttachment } from "../types/attachment"
import { promptSkills } from "./prompt-skills"
import { normalizeSessionMessage } from "../stores/message-v2/normalizers"
import { hydrateRestorableAttachment, normalizeRestorableAttachmentRecord, serializeDraftAttachments } from "../stores/client-state-attachments-codec"

test("explicit skill ids are deduplicated without injecting skill content", () => {
  const skill = createSkillAttachment("opaque/id", "Review")
  assert.deepEqual(promptSkills([skill, skill], "review this"), [{ id: "opaque/id" }])
})

test("removing a restored skill does not resurrect it from the queued payload", () => {
  const payload = { text: "use @review", skills: [{ id: "skill", name: "Review", mention: { text: "@review", start: 4, end: 11 } }] }
  assert.deepEqual(promptSkills([], "use @review", payload), [])
  assert.deepEqual(promptSkills([createSkillAttachment("skill", "Review")], "edited @review", payload), [
    { id: "skill", mention: { text: "@review", start: 7, end: 14 } },
  ])
  assert.deepEqual(promptSkills([createSkillAttachment("skill", "Review")], "edited", payload), [{ id: "skill" }])
})

test("historical skill labels survive normalization without retaining skill body", () => {
  const result = normalizeSessionMessage("session", { type: "user", id: "message", text: "review", time: { created: 1 },
    skills: [{ id: "skill", name: "Review", text: "large native skill content" }] })
  assert.deepEqual(result.message.parts[1], { id: "message-skill-0", type: "skill", skillId: "skill", name: "Review", sessionID: "session", messageID: "message" })
  assert.equal(JSON.stringify(result.message).includes("large native skill content"), false)
})

test("skill drafts survive persistent window-state capture and removal", () => {
  const attachment = createSkillAttachment("review", "Review")
  const saved = serializeDraftAttachments({ session: "review this" }, { session: [attachment] })
  const reloaded = normalizeRestorableAttachmentRecord(JSON.parse(JSON.stringify(saved.attachments)), saved.drafts)!
  const hydrated = hydrateRestorableAttachment(reloaded.attachments.session[0])!
  assert.deepEqual(hydrated, attachment)
  assert.deepEqual(promptSkills([hydrated], saved.drafts.session), [{ id: "review" }])
  const removed = serializeDraftAttachments(saved.drafts, { session: [] })
  assert.equal(removed.attachments.session, undefined)
  assert.equal(removed.drafts.session, "review this")
  for (const source of [{ type: "skill", id: "x".repeat(513), name: "Review" }, { type: "skill", id: "review", name: "x".repeat(1025) }, { type: "skill", id: "", name: "Review" }]) {
    assert.equal(normalizeRestorableAttachmentRecord({ session: [{ ...attachment, source }] }, saved.drafts)!.attachments.session, undefined)
  }
})
