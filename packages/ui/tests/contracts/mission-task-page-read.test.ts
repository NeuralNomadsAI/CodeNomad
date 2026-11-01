import assert from "node:assert/strict"
import test from "node:test"
import { contentDigest } from "../../../server/src/missions/content-digest"
import { missionTaskPage } from "../../../server/src/missions/mission-compact-map"
import { missionPanelPage, MISSION_PANEL_PAGE_BYTES, MISSION_PANEL_REQUEST_BYTES, type MissionPanelPageRequest } from "../../../server/src/missions/mission-panel-page"
import type { MissionMap } from "../../../server/src/missions/model"
import { readMissionTaskPage, taskPageDigest, TASK_PAGE_RESPONSE_BYTES, TASK_PAGE_REQUEST_BYTES } from "../../src/lib/mission-task-page-read"

const map: MissionMap = { version: 1, id: "wide", projectID: "project", projectCanonical: "/fixture", objective: "Wide", template: "custom", status: "active",
  coordinatorSessionId: "coordinator", actors: [], tasks: Array.from({ length: 151 }, (_, index) => ({ id: `tsk_${index}`, key: `t${index}`, title: "\0".repeat(239) + "x",
    brief: "Brief", role: "worker", blockedBy: [], status: "ready", outstandingExecution: false, createdAt: index, updatedAt: index })),
  reports: [], history: [], historyTruncated: false, frontier: [], claims: [], createdAt: 1, updatedAt: 1, revision: 7 }
const header = { projectID: map.projectID, missionID: map.id, source: "tasks" as const, revision: map.revision,
  discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }
const answer = (request: MissionPanelPageRequest) => {
  assert.equal(request.source, "tasks")
  if (request.source !== "tasks") throw new Error("Wrong source")
  return missionPanelPage(header, [missionTaskPage(map, request.task)], request.cursor)
}
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } })
const scope = { projectID: "project", current: () => true }

test("task reads traverse exact byte slices of one requested window, with native UTF-16 digests", async t => {
  assert.equal(TASK_PAGE_RESPONSE_BYTES, MISSION_PANEL_PAGE_BYTES); assert.equal(TASK_PAGE_REQUEST_BYTES, MISSION_PANEL_REQUEST_BYTES)
  for (const text of ["", "😀\u0000", "\ud800", "\ud801"]) assert.equal(await taskPageDigest(text), contentDigest(text))
  const seen = new Set<string>(), sizes: number[] = []
  let transfers = 0
  for (let offset = 0; offset < map.tasks.length; offset += 50) {
    const result = await readMissionTaskPage(map.id, { offset }, { ...scope, exchange: async body => {
      assert.ok(Buffer.byteLength(body) <= 16_384)
      const value = answer(JSON.parse(body)); transfers++
      sizes.push(Buffer.byteLength(JSON.stringify(value)))
      return response(value)
    } })
    assert.ok(result.available && "tasks" in result)
    assert.deepEqual(result.tasks, missionTaskPage(map, { offset }).tasks)
    for (const task of result.tasks) seen.add(task.id)
  }
  assert.equal(seen.size, 151); assert.ok(transfers > 4); assert.equal(Math.max(...sizes), 65_536)
  t.diagnostic(`151 tasks in four requested windows: ${transfers} HTTP transfers, max ${Math.max(...sizes)} bytes`)
})

test("task assembly refuses malformed identity, length, offsets, damage and digests before returning rows", async t => {
  for (const poison of ["digest", "next-digest", "length", "offset", "project", "mission", "revision", "damage", "missing-damage", "extra-header", "wire-bytes", "changed", "unavailable"]) {
    await t.test(poison, async () => {
      let calls = 0
      await assert.rejects(readMissionTaskPage(map.id, { offset: 50 }, { ...scope, exchange: async body => {
        const value = answer(JSON.parse(body))
        assert.ok(value.available); calls++
        if (poison === "changed" && calls === 2) return response({ available: false, reason: "changed" })
        if (poison === "unavailable") return new Response("Unavailable", { status: 503 })
        if (poison === "wire-bytes") return new Response(JSON.stringify(value) + " ".repeat(65_536))
        if (poison === "digest") value.page.digest = "x".repeat(43)
        if (poison === "next-digest" && value.page.next) value.page.next.digest = "x".repeat(43)
        if (poison === "length" && calls === 2) value.page.pieces[0].characters++
        if (poison === "offset") value.page.pieces[0].offset++
        if (poison === "project") value.projectID = "foreign"
        if (poison === "mission") value.missionID = "evil"
        if (poison === "revision" && calls === 2) value.revision!++
        if (poison === "damage") value.controlUnavailable = true
        if (poison === "missing-damage") delete value.notificationUnavailable
        if (poison === "extra-header") Object.assign(value, { unknown: true })
        return response(value)
      } }), error => Boolean(error && typeof error === "object" && "reason" in error && error.reason === (poison === "changed" ? "changed"
        : poison === "unavailable" ? "unavailable" : poison === "damage" ? "damaged" : "invalid")))
      assert.ok(calls <= 3, "a refusal never automatically restarts or falls back")
    })
  }
})

test("the final row digest is checked even with a stable forged envelope, and a stale slice cannot launch its continuation", async () => {
  const row = missionTaskPage(map, { offset: 150 }), bad = missionPanelPage(header, [row])
  assert.ok(bad.available && !bad.page.next)
  bad.page.digest = "x".repeat(43)
  await assert.rejects(readMissionTaskPage(map.id, { offset: 150 }, { ...scope, exchange: async () => response(bad) }), { reason: "invalid" })
  let current = true, calls = 0
  await assert.rejects(readMissionTaskPage(map.id, { offset: 50 }, { ...scope, current: () => current, exchange: async body => {
    calls++; current = false; return response(answer(JSON.parse(body)))
  } }), { name: "AbortError" })
  assert.equal(calls, 1)
})

test("every slice retains the admitted selector even if its caller edits the request", async () => {
  const selector = { offset: 50 }, offsets: number[] = []
  const result = await readMissionTaskPage(map.id, selector, { ...scope, exchange: async body => {
    const request = JSON.parse(body)
    offsets.push(request.task.offset); selector.offset = 100
    return response(answer(request))
  } })
  assert.ok(result.available && "tasks" in result)
  assert.deepEqual(result.tasks, missionTaskPage(map, { offset: 50 }).tasks)
  assert.ok(offsets.length > 1); assert.deepEqual([...new Set(offsets)], [50])
})
