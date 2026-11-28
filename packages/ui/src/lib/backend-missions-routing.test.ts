import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { backendOf } from "./backend-client"
import { loopbackBackend, requestWire } from "../../tests/test-support/backend"
import type { ServerApi } from "./api-client"
import { missionTaskPage } from "../../../server/src/missions/mission-compact-map"
import { missionPanelPage, type MissionPanelPageRequest } from "../../../server/src/missions/mission-panel-page"
import type { MissionMap } from "../../../server/src/missions/model"

type Wire = { url: string; method: string; body: string }
type Case = Wire & { global?: boolean; refused?: boolean; call(api: ServerApi, id: string): Promise<unknown> }
const missionID = "mis/1", scheduleID = "sch/1", passageID = "pas/1", directory = "/repo a+#é"
const scope = { projectID: "project", current: () => true }
const signal = new AbortController().signal
const source = { owner: "scheduled" as const, projectID: "project", scheduleID, passageID, missionID, digest: "a".repeat(43) }
const sourceWire = '{"owner":"scheduled","projectID":"project","scheduleID":"sch/1","passageID":"pas/1","missionID":"mis/1","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
const configuration = { title: "Title", objective: "Goal", template: "custom" as const, profiles: {}, taskMode: "native" as const,
  watchedConversationIDs: [], launch: { when: [] } }
const configurationWire = '{"title":"Title","objective":"Goal","template":"custom","profiles":{},"taskMode":"native","watchedConversationIDs":[],"launch":{"when":[]}}'
const map: MissionMap = { version: 1, id: missionID, projectID: "project", projectCanonical: "/repo", objective: "Goal", template: "custom",
  status: "active", coordinatorSessionId: "coordinator", actors: [], tasks: [{ id: "tsk_1", key: "task", title: "Task", brief: "Brief",
    role: "worker", blockedBy: [], status: "ready", outstandingExecution: false, createdAt: 1, updatedAt: 1 }],
  reports: [], history: [], historyTruncated: false, frontier: [], claims: [], createdAt: 1, updatedAt: 1, revision: 7 }

// Literal local wire contract from 2ef1af162: encoding, query order, methods and JSON bytes.
const cases: Case[] = [
  { url: "/missions", method: "POST", body: '{"objective":"Goal","template":"custom","directory":"/repo a+#é","requestId":"req/1"}',
    call: (a, id) => a.createMission(id, { objective: "Goal", template: "custom", directory, requestId: "req/1" }) },
  { url: "/missions/mis%2F1", method: "PATCH", body: '{"objective":"Edit","notes":"Note","expectedRevision":7,"requestId":"req/1"}',
    call: (a, id) => a.editMission(id, missionID, { objective: "Edit", notes: "Note", expectedRevision: 7, requestId: "req/1" }) },
  { url: "/missions/mis%2F1", method: "DELETE", body: '{"expectedRevision":7,"requestId":"req/1","deleteManagedSessions":true}',
    call: (a, id) => a.deleteMission(id, missionID, { expectedRevision: 7, requestId: "req/1", deleteManagedSessions: true }) },
  { url: "/missions/mis%2F1/control", method: "POST", body: '{"action":"pause","expectedRevision":7,"requestId":"req/1","graceful":true}',
    call: (a, id) => a.controlMission(id, missionID, { action: "pause", expectedRevision: 7, requestId: "req/1", graceful: true }) },
  { url: "/missions/mis%2F1/recover", method: "POST", body: '{"expectedRevision":7,"target":"report","taskKey":"task"}',
    call: (a, id) => a.recoverMission(id, missionID, { expectedRevision: 7, target: "report", taskKey: "task" }) },
  { url: "/missions/mis%2F1", method: "GET", body: "", call: (a, id) => a.fetchMission(id, missionID) },
  { url: "/missions/mis%2F1/admission", method: "GET", body: "", call: (a, id) => a.fetchMissionAdmission(id, missionID) },
  { url: "/missions/panel-page", method: "POST", body: '{"source":"mission","missionID":"mis/1","header":true}',
    call: (a, id) => a.fetchMissionPanel(id, { source: "mission", missionID, header: true }, scope) },
  { url: "/missions/panel-page", method: "POST", body: '{"source":"tasks","task":{"offset":0,"missionID":"mis/1"}}',
    call: (a, id) => a.fetchMissionTasks(id, missionID, { offset: 0 }, scope) },
  { url: "/missions/mis%2F1/content?kind=mission&field=objective&offset=0", method: "GET", body: "",
    call: (a, id) => a.fetchMissionContent(id, missionID, { kind: "mission", field: "objective", offset: 0 }, signal) },
  { url: "/api/missions/playbooks?taskMode=native", global: true, method: "GET", body: "", call: a => a.fetchMissionPlaybooks("native") },
  { url: "/api/missions/playbooks?taskMode=independent", global: true, method: "GET", body: "", call: a => a.fetchMissionPlaybooks("independent") },
  { url: "/api/storage/config/ui?conditional=missions-v1", global: true, method: "PATCH", body: '{"patch":{"missions":{}},"expected":[]}',
    call: a => a.patchMissionPreferences({ missions: {} }, []) },
  { url: "/subagent-depth?directory=%2Frepo+a%2B%23%C3%A9", method: "GET", body: "", call: (a, id) => a.getSubagentDepth(id, directory) },
  { url: "/subagent-depth", method: "PUT", body: '{"location":{"directory":"/repo a+#é"},"depth":3,"expectation":"etag"}',
    call: (a, id) => a.setSubagentDepth(id, { location: { directory }, depth: 3, expectation: "etag" }) },
  { url: "/subagent-depth", method: "PUT", body: '{"location":{"directory":"/repo a+#é"},"depth":null,"expectation":"etag"}',
    call: (a, id) => a.setSubagentDepth(id, { location: { directory }, depth: null, expectation: "etag" }) },
]

function answer(wire: Wire, owner: string): { status: number; value: unknown } {
  if (wire.url.endsWith("/page")) return { status: 503, value: { available: false, reason: "observation-unavailable" } }
  if (wire.url.endsWith("/panel-page")) {
    const selector = JSON.parse(wire.body) as MissionPanelPageRequest
    const header = { projectID: "project", missionID, source: selector.source, revision: 7, ...(selector.source === "mission" ? { header: selector.header } : {}), discardedEvents: 0,
      controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }
    return { status: 200, value: missionPanelPage(header,
      selector.source === "tasks" ? [missionTaskPage({ ...map, objective: owner }, selector.task)] : [{ owner }], selector.cursor) }
  }
  if (/\/current(?:\?|$)/.test(wire.url)) return { status: 200, value: {
    version: 1, projectID: "project", ownerRevision: 7, scheduleID, passageID, source,
  } }
  return { status: 200, value: { owner, mission: { ...map, objective: owner }, admitted: true, deleted: true } }
}

async function fixture(t: TestContext, id: string) {
  const requests: Wire[] = []
  let denied = false
  const owner = await loopbackBackend(t, id, (request, response, body) => {
    const wire = { url: request.url!, method: request.method!, body }
    // Node fetch versions differ on transmitting an empty query marker.
    // The local fetch-boundary assertion below retains its exact bytes.
    requests.push({ ...wire, url: wire.url.replace(/\?$/, "") })
    const reply = denied ? { status: 403, value: { error: "denied" } } : answer(wire, id)
    response.writeHead(reply.status, { "Content-Type": "application/json" })
    response.end(JSON.stringify(reply.value))
  })
  return { ...owner, requests, deny: () => { denied = true } }
}

function expected(item: Case, http = false): Wire {
  const url = item.global ? item.url : `/api/workspaces/w%2F1${item.url}`
  // Normalize only the transport's optional empty query marker.
  return { url: http ? url.replace(/\?$/, "") : url, method: item.method, body: item.body }
}

async function exercise(api: ServerApi, key: string) {
  for (const item of cases) {
    if (item.refused) await assert.rejects(item.call(api, key), { reason: "unavailable" })
    else await item.call(api, key)
  }
}

test("every Missions/depth HTTP family stays with its selected backend and strips only the workspace prefix", async t => {
  const a = await fixture(t, "missionsA"), b = await fixture(t, "missionsB")
  // A mistaken relative/local dispatch must fail even though both real servers are reachable.
  const fetch = globalThis.fetch
  t.mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    assert.match(String(input), /^http:\/\/127\.0\.0\.1:/, "remote calls cannot fall back to local")
    return fetch(input, init)
  })
  for (const owner of [a, b]) {
    const key = `${owner.backend.id}~w/1`
    assert.equal(backendOf(key), owner.backend)
    await exercise(backendOf(key).api, key)
    assert.deepEqual(owner.requests, cases.map(item => expected(item, true)))
    const result = await backendOf(key).api.fetchMissionAdmission(key, missionID)
    assert.ok("mission" in result)
    assert.equal(result.mission?.objective, owner.backend.id, "response came from the owning server")
    const panel = await backendOf(key).api.fetchMissionPanel(key, { source: "mission", missionID, header: true }, scope)
    assert.deepEqual(panel.values, [{ owner: owner.backend.id }])
    const tasks = await backendOf(key).api.fetchMissionTasks(key, missionID, { offset: 0 }, scope)
    assert.ok(tasks.available && "tasks" in tasks)
    assert.equal(tasks.tasks[0].key, "task", "valid task wire envelope was assembled")
  }
  assert.equal(a.requests.length, cases.length + 3, "B never dispatches through A")
  assert.equal(b.requests.length, cases.length + 3, "A never dispatches through B")
  b.deny()
  for (const item of cases) await assert.rejects(item.call(backendOf("missionsB~w/1").api, "missionsB~w/1"))
  assert.equal(a.requests.length, cases.length + 3, "refusals never retry on another backend")
  assert.deepEqual(b.requests.slice(cases.length + 3), cases.map(item => expected(item, true)), "each refusal dispatches once, without replay")
})

test("local Missions/depth requests preserve the exact baseline wire, including headers and credentials", async t => {
  const wire: (Wire & { headers: [string, string][]; credentials?: RequestCredentials })[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { ...requestWire(input, init), body: String(init?.body ?? "") }
    wire.push(request)
    const reply = answer(request, "local")
    return Response.json(reply.value, { status: reply.status })
  })
  await exercise(backendOf("w/1").api, "w/1")
  assert.deepEqual(wire, cases.map(item => ({ ...expected(item),
    headers: item.body ? [["content-type", "application/json"]] : [], credentials: "include" })))
})

test("an absent backend cannot dispatch any Missions/depth request to local or another server", async t => {
  const a = await fixture(t, "presentMissionA"), b = await fixture(t, "presentMissionB")
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected fallback") })
  for (const item of cases) {
    await assert.rejects(async () => item.call(backendOf("absentMissions~w/1").api, "absentMissions~w/1"), /Backend unavailable: absentMissions/)
  }
  assert.equal(calls, 0)
  assert.deepEqual(a.requests, [])
  assert.deepEqual(b.requests, [])
})
