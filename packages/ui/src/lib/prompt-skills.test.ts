import assert from "node:assert/strict"
import { test } from "node:test"
import { createSkillAttachment } from "../types/attachment"
import { promptSkills } from "./prompt-skills"
import { normalizeSessionMessage } from "../stores/message-v2/normalizers"

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
