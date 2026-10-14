import assert from "node:assert/strict"
import test from "node:test"

import { isMissionActivityEvent, isMissionChangedEvent } from "./missions"

test("refreshes activity only for bounded native state transitions", () => {
  for (const type of [
    "session.execution.started", "session.execution.succeeded", "session.execution.failed",
    "session.execution.interrupted", "session.status", "session.idle", "session.inbox.enqueued",
     "shell.created", "shell.exited", "form.created", "form.replied", "permission.asked", "permission.replied",
     "session.created", "session.forked", "session.moved", "session.deleted",
     "session.compaction.started", "session.compaction.ended", "session.compaction.failed",
  ]) assert.equal(isMissionActivityEvent({ type }), true, type)
  for (const type of ["session.text.delta", "session.tool.progress", "session.message.content.updated", "filesystem.changed", "session.compaction.delta",
    "session.child.created", "session.location.changed", "session.compacted"])
    assert.equal(isMissionActivityEvent({ type }), false, type)
  assert.equal(isMissionChangedEvent({ type: "rpc.codenomad.missions.changed" }), true)
})
