import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import { sessionGoals } from "./session-goal"

test("a late plugin activation refreshes the demanded goal once, with no hidden-session reads", async () => {
  const original = serverApi.fetchSessionGoal
  const instanceId = "late-goal-plugin", sessionId = "ses_late_goal"
  let reads = 0
  serverApi.fetchSessionGoal = async () => ++reads === 1 ? { status: "unavailable" } : { status: "goal", goal: null }
  const emit = () => (serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId,
    event: { type: "plugin.updated", data: {}, location: { directory: "/fixture" } } }])
  const until = async (check: () => boolean) => {
    const end = Date.now() + 2_000
    while (!check()) { assert(Date.now() < end, "Goal activation refresh deadline"); await delay(10) }
  }
  const release = sessionGoals.demand(instanceId, sessionId)
  try {
    await until(() => sessionGoals.state(instanceId, sessionId).status === "unavailable")
    emit(); emit(); emit()
    await until(() => sessionGoals.state(instanceId, sessionId).status === "goal")
    assert.equal(reads, 2)
    release()
    emit()
    await delay(100)
    assert.equal(reads, 2, "Activation must not load hidden goals")
  } finally {
    release()
    ;(serverEvents as any).dispatchBatch([{ type: "workspace.stopped", workspaceId: instanceId }])
    serverApi.fetchSessionGoal = original
  }
})
