import assert from "node:assert/strict"
import test from "node:test"

import { isMissionActivityEvent, isMissionChangedEvent, missionStore, shouldRefreshMissionActivity } from "./missions"
import { eventSessionRefs, isUnrelatedSessionEvent } from "./mission-activity-filter"

test("refreshes activity only for bounded native state transitions", () => {
  for (const type of [
    "session.execution.started", "session.execution.succeeded", "session.execution.failed",
    "session.execution.interrupted", "session.inbox.enqueued",
     "shell.created", "shell.exited", "form.created", "form.replied", "permission.asked", "permission.replied",
     "session.created", "session.forked", "session.moved", "session.deleted",
     "session.compaction.started", "session.compaction.ended", "session.compaction.failed",
  ]) assert.equal(isMissionActivityEvent({ type }), true, type)
  // OpenCode V2 never publishes the deprecated session.status/session.idle declarations.
  for (const type of ["session.text.delta", "session.tool.progress", "session.message.content.updated", "filesystem.changed", "session.compaction.delta",
    "session.child.created", "session.location.changed", "session.compacted", "session.status", "session.idle"])
    assert.equal(isMissionActivityEvent({ type }), false, type)
  assert.equal(isMissionChangedEvent({ type: "rpc.codenomad.missions.changed" }), true)
})

test("unrelated session filtering skips provably unrelated roots while keeping mission families and unknown sessions", () => {
  const sessionsMap = new Map([
    ["ses_chat", { parentID: null }],
    ["ses_chat_child", { parentID: "ses_chat" }],
    ["ses_coord", { parentID: null }],
    ["ses_subagent", { parentID: "ses_coord" }],
  ])
  const roots = new Set(["ses_coord"])
  assert.deepEqual(eventSessionRefs({ type: "session.execution.started", data: { sessionID: "ses_chat" } }), { sessionID: "ses_chat", parentID: undefined })
  assert.deepEqual(eventSessionRefs({ type: "form.created", data: { form: { sessionID: "ses_subagent" } } }), { sessionID: "ses_subagent", parentID: undefined })
  assert.deepEqual(eventSessionRefs({ type: "session.created", data: { info: { id: "ses_new", parentID: "ses_coord" } } }), { sessionID: "ses_new", parentID: "ses_coord" })

  assert.equal(isUnrelatedSessionEvent({ type: "session.execution.started", data: { sessionID: "ses_chat" } }, roots, sessionsMap), true)
  assert.equal(isUnrelatedSessionEvent({ type: "session.execution.started", data: { sessionID: "ses_chat_child" } }, roots, sessionsMap), true)
  assert.equal(isUnrelatedSessionEvent({ type: "session.created", data: { info: { id: "ses_new_chat_child", parentID: "ses_chat" } } }, roots, sessionsMap), true)
  assert.equal(isUnrelatedSessionEvent({ type: "session.execution.started", data: { sessionID: "ses_coord" } }, roots, sessionsMap), false)
  assert.equal(isUnrelatedSessionEvent({ type: "session.execution.started", data: { sessionID: "ses_subagent" } }, roots, sessionsMap), false)
  assert.equal(isUnrelatedSessionEvent({ type: "session.created", data: { info: { id: "ses_new_sub", parentID: "ses_coord" } } }, roots, sessionsMap), false)
  assert.equal(isUnrelatedSessionEvent({ type: "session.execution.started", data: { sessionID: "ses_unknown" } }, roots, sessionsMap), false, "unloaded sessions stay conservative")
  assert.equal(isUnrelatedSessionEvent({ type: "shell.created", data: { info: { cwd: "/repo" } } }, roots, sessionsMap), false, "events without sessionID stay conservative")
})

test("activity events do not refresh missions when the instance has no active missions", () => {
  missionStore.clear("idle-instance")
  assert.equal(shouldRefreshMissionActivity("idle-instance", { type: "session.execution.started", data: { sessionID: "ses_any" } }), false)
})
