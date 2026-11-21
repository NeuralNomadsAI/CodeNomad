// Calendar HTTP contract against the native service and its bundled Missions plugin.
import assert from "node:assert/strict"
import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

const enableInProject = process.env.CNRS_BENCH_MISSIONS_ENABLE_IN_PROJECT === "1"
const marker = "FIXTURE_CALENDAR_TOOL:"
export const runtime = { service: true, projectConfig: enableInProject, respond({messages, tools}) {
  const text = messages.findLast(m => m.role === "user")?.content
  const encoded = typeof text === "string" ? text : text?.find(p => p.type === "text")?.text
  if (!encoded?.startsWith(marker)) return undefined
  const { name, input, id } = JSON.parse(encoded.slice(marker.length))
  if (messages.some(m => m.tool_call_id === id) || !tools?.some(t => t.function.name === name)) return undefined
  return { role: "assistant", tool_calls: [{ index: 0, id, type: "function",
    function: { name, arguments: JSON.stringify(input) } }] }
} }
export const prepare = async ({ configDirectory }) => {
  if (enableInProject) await writeFile(path.join(configDirectory, "opencode.jsonc"), '{"experimental":{"subagent_depth":1}}\n')
  return { ...(enableInProject ? {} : { experimental: { automations: true } }),
    agents: { fixture_specialist: { mode: "subagent", description: "Isolated calendar role" } } }
}
export const environment = () => ({ CNRS_FIXTURE_MISSIONS_CALENDAR: "1" })
export const configure = () => "  environmentVariables: {}\n"
export const holdProvider = "FIXTURE_DAILY_PASSAGE_HELD"

export async function run({ call, fixture: { client, env }, root, folder }) {
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
      v => ({ api: v.api?.available, enabled: v.enabled, activation: v.activation?.available, scopes: v.activation?.targets.map(x => x.scope) }))
    assert.equal(capabilities.api?.available, true)
    if (enableInProject) {
      assert.equal(capabilities.enabled, false, JSON.stringify(capabilities))
      assert.deepEqual(capabilities.activation?.targets.map(x => x.scope), ["project"])
    }
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
    if (enableInProject) {
      const [target] = document.scheduleActivation.targets
      assert.equal(target.scope, "project")
      assert.equal(target.attempted, true)
      assert.equal(target.acknowledged, true)
      const project = JSON.parse(await readFile(target.path, "utf8"))
      assert.deepEqual(project.experimental, { subagent_depth: 1, automations: true })
      await request("schedule-activate-replay", setting, activation, v => ({ ...state(v), sameRevision: v.document?.revision === document.revision }))
      observations.activationWrite = project.experimental
    }
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
    const agent = await client.session.create({ location, title: "Calendar agent fixture", ...role })
    const runTool = async (name, step, input) => {
      const id = `call_calendar_${step}`
      const prompt = await client.session.prompt({ sessionID: agent.id,
        text: `${marker}${JSON.stringify({ name, input, id })}` })
      const end = Date.now() + 120_000
      while (Date.now() < end) {
        const rows = await client.message.list({ sessionID: agent.id, limit: { order: "desc", limit: 12 } })
        const part = rows.data.flatMap(r => r.content ?? []).find(p => p.type === "tool" && p.id === id)
        if (part?.state.status === "completed") {
          const output = JSON.parse(part.state.content.find(p => p.type === "text").text)
          assert(!output.error, JSON.stringify(output))
          return output
        }
        if (part?.state.status === "error") throw new Error(`${name}: ${part.state.error}`)
        await delay(100)
      }
      throw new Error(`Timed out: ${name} ${prompt?.id ?? ""}`)
    }
    const { launch, template, taskMode } = config
    const preparation = { requestID: "agent_schedule_fixture", title: "Agent calendar fixture",
      objective: "Verify the paused agent preparation and exact replay.", launch, template, taskMode, profiles }
    const fresh = await runTool("mission_prepare", "prepare", preparation)
    assert.equal(fresh.outcome, "prepared", JSON.stringify(fresh))
    assert.equal(fresh.acknowledgement, "fresh")
    const preparedByAgent = fresh.target.document
    const replay = await runTool("mission_prepare", "replay", preparation)
    assert.equal(replay.acknowledgement, "recovered")
    assert.equal(replay.target.document.missionID, preparedByAgent.missionID)
    observations.agentPreparation = [fresh.outcome, replay.outcome, preparedByAgent.state]
    const configured = await runTool("mission_schedule", "configure", { action: "configure", missionID: preparedByAgent.missionID,
      requestID: "agent_configure_fixture", expectedRevision: preparedByAgent.revision,
      configuration: { ...config, title: "Agent calendar edited" } })
    assert.equal(configured.status, 200, JSON.stringify(configured))
    assert.equal(configured.document?.configuration.title, "Agent calendar edited")
    observations.agentConfigure = configured.document.state
    let agentDoc = configured.document
    for (const [action, state] of [["play","running"],["pause","paused"],["resume","running"],["stop","stopped"]]) {
      const result = await runTool("mission_schedule", action, { action, missionID: preparedByAgent.missionID,
        expectedRevision: agentDoc.revision, requestID: `agent_${action}_fixture` })
      assert.equal(result.status, 200, JSON.stringify(result))
      assert.equal(result.document?.state, state)
      agentDoc = result.document
      observations[`agent-${action}`] = result.document.state
    }
    const deleted = await runTool("mission_schedule", "delete", { action: "delete", missionID: agentDoc.id,
      expectedRevision: agentDoc.revision, requestID: "agent_delete_fixture", deleteManagedSessions: false })
    assert.equal(deleted.status, 200, JSON.stringify(deleted))
    assert.equal(deleted.deleted, true)
    observations.agentDelete = deleted.deleted
    const automatic = { ...preparation, requestID: "agent_schedule_auto_fixture", startOnCreation: true }
    const started = await runTool("mission_prepare", "auto", automatic)
    const autoDoc = started.target?.document
    assert.equal(started.outcome, "activated", JSON.stringify(started))
    assert.equal(autoDoc?.state, "running")
    const autoReplay = await runTool("mission_prepare", "auto_replay", automatic)
    assert.equal(autoReplay.acknowledgement, "recovered")
    assert.equal(autoReplay.target.document.revision, autoDoc.revision)
    const stopped = await runTool("mission_schedule", "auto_stop", { action: "stop", missionID: autoDoc.missionID,
      expectedRevision: autoDoc.revision, requestID: "agent_auto_stop_fixture" })
    assert.equal(stopped.document?.state, "stopped", JSON.stringify(stopped))
    observations.agentAutomatic = [started.outcome, autoReplay.outcome, stopped.document.state]
    const daily = `${base}/recurrence`
    const input = { requestID: "daily_create_fixture", instructions: `${holdProvider}: keep the provider open for readback.`,
      template: "custom", profiles, taskMode: "native", watchedConversationIDs: [],
      clock: { time: new Date(Date.now() + 3 * 3600_000).toISOString().slice(11, 16), zone: "UTC" } }
    const { requestID: _daily, ...creation } = { ...input, instructions: "Daily Mission agent fixture." }
    const dailyAgent = await runTool("mission_schedule", "daily_create", { action: "create", owner: "daily",
      creation, requestID: "agent_daily_create_fixture" })
    assert.equal(dailyAgent.status, 200, JSON.stringify(dailyAgent))
    const dailyAgentId = dailyAgent.missionID
    const dailyAgentReplay = await runTool("mission_schedule", "daily_creation_read", { action: "read", owner: "daily",
      creation, requestID: "agent_daily_create_fixture" })
    assert.equal(dailyAgentReplay.missionID, dailyAgentId)
    const dailyAgentList = await runTool("mission_schedule", "daily_list", { action: "list", owner: "daily" })
    assert(dailyAgentList.schedules.some(item => item.missionID === dailyAgentId && item.state === "paused"))
    for (const [action, state] of [["play", "running"], ["pause", "paused"], ["stop", "stopped"]]) {
      const snapshot = await runTool("mission_schedule", `daily_${action}_snapshot`, { action: "read", owner: "daily", missionID: dailyAgentId })
      const args = { owner: "daily", missionID: dailyAgentId, requestID: `agent_daily_${action}_fixture`, expectedRevision: snapshot.schedule.revision }
      const changed = await runTool("mission_schedule", `daily_${action}`, { ...args, action })
      assert.equal(changed.status, 200, JSON.stringify(changed))
      assert.equal(changed.state, state)
      const exact = await runTool("mission_schedule", `daily_${action}_read`, { ...args, action: "read", receiptAction: action })
      assert.equal(exact.outcome, "committed", JSON.stringify(exact))
      observations[`agent-daily-${action}`] = [changed.state, exact.outcome]
    }
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
    if (enableInProject) {
      const { document: off } = await request("schedule-off-create", `${base}/scheduled`,
        { ...create, requestID: "schedule_off_fixture" }, state)
      const global = path.join(env.OPENCODE_CONFIG_DIR, "opencode.jsonc")
      await writeFile(global, '{"experimental":{"schedules":false,"subagent_depth":1}}\n')
      const until = Date.now() + 30_000
      while (!(await client.config.get({ location })).some(e => e.path === global && e.info?.experimental?.schedules === false)) {
        assert(Date.now() < until, "OpenCode did not report the explicit global OFF")
        await delay(100)
      }
      const blocked = await request("schedule-capability-hidden-off", `${base}/scheduled/capabilities`, undefined,
        v => ({ enabled:v.enabled, writable:v.activation?.available, reason:v.activation?.refusal?.reason }))
      assert.equal(blocked.enabled, true, JSON.stringify(blocked))
      assert.equal(blocked.activation.available, false)
      const refused = { requestID: "schedule_off_activation", expectedDocumentRevision: off.revision }
      const offSettings = `${base}/${off.id}/schedule-settings`
      const denied = await request("schedule-explicit-off", offSettings, refused,
        v => ({ code:v.code, reason:v.refusal?.reason, layer:v.refusal?.layer, notApplied:v.notApplied }), 403)
      assert.equal(denied.refusal?.reason, "explicit-off")
      assert.deepEqual(denied.notApplied, { requestID:refused.requestID, expectedRevision:off.revision })
      const original = await request("schedule-off-read", `${offSettings}?${new URLSearchParams(refused)}`, undefined, state)
      assert.equal(original.document.scheduleActivation, null)
    }
    return observations
  } catch (error) {
    error.partial = observations
    throw error
  } finally {
    await call(`/api/workspaces/${workspace.id}`, { method: "DELETE" })
  }
}
