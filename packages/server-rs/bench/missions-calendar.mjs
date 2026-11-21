// Calendar HTTP contract against the native service and its bundled Missions plugin.
import assert from "node:assert/strict"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export const runtime = { service: true }
export const prepare = () => ({ experimental: { automations: true },
  agents: { fixture_specialist: { mode: "subagent", description: "Isolated calendar role" } } })
export const environment = () => ({ CNRS_FIXTURE_MISSIONS_CALENDAR: "1" })
export const configure = () => "  environmentVariables: {}\n"
export const holdProvider = "FIXTURE_DAILY_PASSAGE_HELD"

export async function run({ call, fixture: { client }, root, folder }) {
  const observations = {}
  async function request(name, route, body, project, status = 200) {
    const response = await call(route, { signal: AbortSignal.timeout(90_000), ...(body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }) })
    const raw = await response.text()
    let value
    try { value = JSON.parse(raw) }
    catch { throw new Error(`${name}: expected JSON, received HTTP ${response.status}`) }
    observations[name] = [response.status, project ? project(value) : value]
    assert.equal(response.status, status, `${name}: ${value.code ?? value.reason ?? value.error ?? ""}`)
    return value
  }
  const workspace = await request("workspace", "/api/workspaces", { path: path.join(root, folder) }, () => true, 201)
  const base = `/api/workspaces/${workspace.id}/missions`
  const location = { directory: workspace.location?.directory ?? workspace.path }
  try {
    const deadline = Date.now() + 30_000
    while (!(await client.plugin.list({ location })).data.some(p => p.id === "codenomad.missions" && p.state.status === "active")) {
      assert(Date.now() <= deadline, "Calendar plugin did not activate")
      await delay(100)
    }
    const role = { agent: "build", model: { providerID: "fixture", id: "fixture" } }
    const profiles = { coordinator: role, roles: { specialist: { ...role, agent: "fixture_specialist" } } }
    const config = { title: "Calendar fixture", objective: "Prove exact calendar control receipts.",
      template: "custom", profiles, taskMode: "native", watchedConversationIDs: [],
      launch: { when: [{ kind: "cron", expression: "0 0 1 1 *", zone: "UTC" }] } }
    const state = v => ({ state: v.document?.state, count: v.document?.launchedCount, pending: v.pending,
      ready: v.document?.scheduleActivation?.state })
    const receipt = v => ({ ...state(v), action: v.document?.control?.action, controlPending: v.document?.control?.pending })
    const capabilities = await request("capabilities", `${base}/scheduled/capabilities`, undefined,
      v => ({ api: v.api?.available, enabled: v.enabled, activation: v.activation?.available }))
    assert.equal(capabilities.api?.available, true)
    const create = { requestID: "schedule_create_fixture", expectedRevision: 0, action: "create", configuration: config }
    const { document: prepared } = await request("schedule-create", `${base}/scheduled`, create, state)
    assert.equal(prepared.state, "paused")
    const mid = prepared.id
    await request("schedule-creation-receipt", `${base}/scheduled/requests/${create.requestID}`, undefined,
      v => ({ ...state(v), exact: v.document?.id === mid }))
    await request("schedule-list", `${base}/scheduled?limit=8`, undefined,
      v => ({ has: v.schedules?.some(item => item.id === mid) }))
    const setting = `${base}/${mid}/schedule-settings`
    const activation = { requestID: "schedule_activate_fixture", expectedDocumentRevision: prepared.revision }
    let { document } = await request("schedule-activate", setting, activation, state)
    await request("schedule-activate-receipt", `${setting}?${new URLSearchParams(activation)}`, undefined, state)
    const scheduled = `${base}/${mid}/schedule`
    for (const [action, expected] of [["play", "running"], ["pause", "paused"], ["resume", "running"], ["stop", "stopped"]]) {
      const input = { requestID: `schedule_${action}_fixture`, expectedRevision: document.revision, action }
      ;({ document } = await request(`schedule-${action}`, scheduled, input, receipt))
      assert.equal(document.state, expected)
      assert.equal(document.launchedCount, 0)
      await request(`schedule-${action}-receipt`, `${scheduled}?requestID=${input.requestID}`, undefined, receipt)
      if (action === "play") {
        const principal = document.technical?.carriers.find(c => c.role === "principal")
        assert(principal?.scheduleID, "Play did not record a principal Automation")
        const automation = await client.experimental.automation.get({ automationID: principal.scheduleID })
        assert.equal(automation.action.type, "code")
        observations.calendarAction = automation.action.type
      }
    }
    const daily = `${base}/recurrence`
    const input = { requestID: "daily_create_fixture", instructions: `${holdProvider}: keep the provider open for readback.`,
      template: "custom", profiles, taskMode: "native", watchedConversationIDs: [],
      clock: { time: new Date(Date.now() + 3 * 3600_000).toISOString().slice(11, 16), zone: "UTC" } }
    const { schedule } = await request("daily-create", daily, input, v => ({ state: v.schedule?.state }))
    const sid = schedule.id
    await request("daily-create-replay", daily, input, v => ({ same: v.schedule?.id === sid }))
    for (const action of ["play", "pause", "stop"]) {
      const snapshot = await request(`daily-${action}-snapshot`, daily, undefined,
        v => ({ present: v.schedules?.some(x => x.id === sid) }))
      const body = { requestID: `daily_${action}_fixture`, expectedRevision: snapshot.schedules.find(item => item.id === sid).revision, action }
      const route = `${daily}/${sid}/control`
      await request(`daily-${action}`, route, body, v => ({ state: v.state, complete: v.controlsComplete }))
      await request(`daily-${action}-receipt`, `${route}/status`, body, v => ({ state: v.state, outcome: v.outcome }))
      if (action === "pause") {
        const paused = await request("daily-paused-snapshot", daily, undefined, v => ({ present: v.schedules?.some(x => x.id === sid) }))
        const manual = { requestID: "daily_run_fixture", expectedRevision: paused.schedules.find(x => x.id === sid).revision }
        const run = `${daily}/${sid}/run-now`
        await request("daily-run-now", run, manual, v => ({ outcome: v.outcome }))
        await request("daily-run-now-receipt", `${run}/status?${new URLSearchParams(manual)}`, undefined, v => ({ outcome: v.outcome }))
        const current = `${daily}/${sid}/current`
        const view = await request("daily-current", current, undefined, v => ({ hasPassage: Boolean(v.source?.passageID) }))
        assert(view.source?.passageID, "The held passage has no current source")
        const page = `${current}/${view.source.passageID}/page`
        await request("daily-current-activity", page, { source: view.source, selector: { source: "activity", missionID: view.source.missionID } },
          v => ({ available: v.available, phase: v.phase, total: v.page?.total }))
        await request("daily-current-content", `${current}/${view.source.passageID}/content?kind=overview&section=objective`, undefined,
          v => ({ section: v.section, page: v.page }))
      }
    }
    return observations
  } catch (error) {
    error.partial = observations
    throw error
  } finally {
    await call(`/api/workspaces/${workspace.id}`, { method: "DELETE" })
  }
}
