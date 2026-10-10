import assert from "node:assert/strict"
import { test } from "node:test"
import type { MissionMap, MissionTask } from "../../../server/src/api-types"
import { missionTaskConversation } from "./mission-task-navigation"
import type { MissionObservedFamily } from "./mission-attention-model"

const mission = { coordinatorSessionId: "ses_root", actors: [{ sessionId: "ses_root" }, { sessionId: "ses_actor" }] } as MissionMap
const task = { key: "task" } as MissionTask
const family: MissionObservedFamily = { state: "observed", members: [
  { sessionId: "ses_child", parentSessionId: "ses_root", actorSessionId: "ses_root", kind: "ordinary", taskKey: "task" },
] }
test("opens exact owned actors and never infers a child from task context or report evidence", () => {
  assert.equal(missionTaskConversation(mission, { ...task, actorSessionId: "ses_actor" }), "ses_actor")
  assert.equal(missionTaskConversation(mission, task, family), undefined)
  assert.equal(missionTaskConversation(mission, { ...task, actorSessionId: "ses_child" }, family), "ses_child")
  assert.equal(missionTaskConversation(mission, { ...task, actorSessionId: "ses_elsewhere" }, family), undefined)
  assert.equal(missionTaskConversation(mission, { ...task, actorSessionId: "ses_child" }, { ...family, state: "unknown" }), undefined)
  assert.equal(missionTaskConversation(mission, { ...task, actorSessionId: "global" }), undefined)
  assert.equal(missionTaskConversation(mission, { ...task, actorSessionId: "ses_root" }), undefined)
})
test("a derived delegation child opens only when no other task owns that conversation", () => {
  const withTasks = { ...mission, tasks: [task, { key: "other", actorSessionId: "ses_other" }] } as MissionMap
  assert.equal(missionTaskConversation(withTasks, task, undefined, "ses_derived"), "ses_derived")
  assert.equal(missionTaskConversation(withTasks, task, undefined, "ses_other"), undefined)
  assert.equal(missionTaskConversation(withTasks, task, undefined, "ses_root"), undefined)
  assert.equal(missionTaskConversation(withTasks, task, undefined, "global"), undefined)
  assert.equal(missionTaskConversation(withTasks, { ...task, actorSessionId: "ses_actor" }, undefined, "ses_derived"), "ses_actor")
})
test("all ten locales distinguish instruction delivery, card edits and reported blockages", async () => {
  const en = (await import("../lib/i18n/messages/en/missions")).missionMessages as Record<string, string>
  const keys = Object.keys(en).filter(key => key.startsWith("missions.control.guidance.") || key.startsWith("missions.control.blockages."))
  assert.ok(keys.length >= 16)
  for (const locale of ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const messages = (await import(`../lib/i18n/messages/${locale}/missions.ts`)).missionMessages as Record<string, string>
    for (const key of keys) {
      assert.ok(Object.prototype.hasOwnProperty.call(messages, key) && messages[key].trim(), `${locale}: ${key}`)
      if (locale !== "en") assert.notEqual(messages[key], en[key], `${locale}: translated ${key}`)
    }
  }
})
