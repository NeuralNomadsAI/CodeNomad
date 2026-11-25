import assert from "node:assert/strict"
import test from "node:test"

import { isMissionActivityEvent, isMissionChangedEvent, missionStore, shouldRefreshMissionActivity } from "./missions"
import { eventSessionRefs, isUnrelatedSessionEvent } from "./mission-activity-filter"
import { addInstance, removeInstance } from "./instances"
import { missionPanelPage } from "../../../server/src/missions/mission-panel-page"
import { missionPanelHeader } from "../../../server/src/missions/mission-panel-header"
import type { MissionMap } from "../../../server/src/missions/model"

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

test("shouldRefreshMissionActivity requires marks or map coverage to match the current summary revision", async () => {
  const instanceId = "rev-check-instance", projectID = "proj_rev", originalFetch = globalThis.fetch
  let summaryRevision = 2, marksRevision = 1, mapRevision = 1
  const makeMap = (revision: number): MissionMap => ({
    version: 1, id: "msn_rev", projectID, projectCanonical: "/repo", objective: "Check revision",
    template: "custom", taskMode: "native", status: "active", runState: "running",
    coordinatorSessionId: "ses_coord", revision, createdAt: 100, updatedAt: 200,
    actors: [{ sessionId: "ses_coord", kind: "coordinator", managed: false, title: "Coordinator", roles: ["coordinator"], location: { directory: "/repo" }, joinedAt: 100 }],
    tasks: [], reports: [], history: [], historyTruncated: false, frontier: [], claims: [],
  })
  const sessionsMap = new Map([
    ["ses_chat", { parentID: null }],
    ["ses_coord", { parentID: null }],
  ])
  const unrelatedEvent = { type: "session.execution.started", data: { sessionID: "ses_chat" } }
  globalThis.fetch = (async (_input, init) => {
    const selector = JSON.parse(String(init?.body ?? "{}"))
    const baseMeta = { projectID, discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }
    const digest = "a".repeat(43)
    if (selector.source === "summaries") {
      return new Response(JSON.stringify(missionPanelPage({ ...baseMeta, source: "summaries", ...(selector.initial ? { finishHighWater: 0 } : {}),
        window: { order: digest, offset: 0, end: 1, total: 1 } }, [{
        id: "msn_rev", objective: "Check revision", status: "active", runState: "running",
        coordinatorSessionId: "ses_coord", actorCount: 1, updatedAt: 200, revision: summaryRevision,
      }], selector.cursor)))
    }
    if (selector.source === "cleanups") {
      return new Response(JSON.stringify(missionPanelPage({ ...baseMeta, source: "cleanups",
        window: { order: digest, offset: 0, end: 0, total: 0 } }, [], selector.cursor)))
    }
    if (selector.source === "marks") {
      const obs = {
        context: {
          id: "msn_rev", projectID, revision: marksRevision, status: "active", runState: "running",
          coordinatorSessionId: "ses_coord",
          actors: [{ sessionId: "ses_coord", title: "Coordinator", location: { directory: "/repo" }, reportOwed: false, callOpen: false }],
          actorPage: { order: digest, offset: 0, end: 1, total: 1 },
          discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false,
        },
        coverage: "observed",
        requests: { state: "observed", items: [] },
        activity: { actors: [{ sessionId: "ses_coord", state: "running" }], family: { state: "observed", members: [] } },
      }
      return new Response(JSON.stringify(missionPanelPage({ ...baseMeta, source: "marks", phase: "observed", observedAt: 300 }, [{
        missionPage: { order: digest, offset: 0, end: 1, total: 1 },
        observations: [obs],
      }], selector.cursor)))
    }
    if (selector.source === "mission" && selector.header) {
      const header = missionPanelHeader(makeMap(mapRevision))
      return new Response(JSON.stringify(missionPanelPage({ ...baseMeta, source: "mission", missionID: "msn_rev", revision: mapRevision, header: true }, [header], selector.cursor)))
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 })
  }) as typeof globalThis.fetch
  addInstance({ id: instanceId, folder: "/repo", port: 0, pid: 0, proxyPath: "", status: "ready", client: null, metadata: { project: { id: projectID } } as any })
  try {
    missionStore.setDemand(instanceId, true)
    await missionStore.refresh(instanceId, false)
    assert.equal(missionStore.state(instanceId).status, "ready")
    assert.equal(missionStore.state(instanceId).summaries.length, 1)
    assert.equal(missionStore.markObservations(instanceId, "msn_rev").length, 1)
    // Summary is at revision 2 while marks are still at revision 1: must NOT rule out unrelated events yet.
    assert.equal(shouldRefreshMissionActivity(instanceId, unrelatedEvent, sessionsMap), true,
      "stale marks revision (< summary revision) must not rule out activity events")

    // Once marks catch up to summary revision 2, unrelated root events are filtered out.
    marksRevision = 2
    await missionStore.refresh(instanceId, false)
    assert.equal(shouldRefreshMissionActivity(instanceId, unrelatedEvent, sessionsMap), false,
      "current marks revision matching summary revision filters unrelated root events")

    // With stale marks again (summary bumped to 3), a stale loaded native map at revision 2 must not rule out events either.
    summaryRevision = 3; mapRevision = 2
    missionStore.want(instanceId, "selection", "msn_rev", false, undefined, false)
    await missionStore.refresh(instanceId, false)
    assert.equal(shouldRefreshMissionActivity(instanceId, unrelatedEvent, sessionsMap), true,
      "stale native map revision (< summary revision) must not rule out activity events")

    // Once the native map header matches summary revision 3, unrelated root events are filtered out.
    mapRevision = 3
    await missionStore.refresh(instanceId, false)
    assert.equal(shouldRefreshMissionActivity(instanceId, unrelatedEvent, sessionsMap), false,
      "native map matching summary revision filters unrelated root events")
  } finally {
    missionStore.want(instanceId, "selection", undefined)
    missionStore.setDemand(instanceId, false)
    missionStore.clear(instanceId)
    removeInstance(instanceId)
    globalThis.fetch = originalFetch
  }
})
