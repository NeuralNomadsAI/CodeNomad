import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerMissionRoutes } from "./missions"
import { createManagedMissionRoot } from "./mission-root-creation"
import { setupMissionsPlugin } from "../../opencode/missions-plugin"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { controlAgentMissionProgram } from "./mission-agent-program"
import { missionProgramInput } from "../../missions/program-tool"
import { legacyScheduleKey } from "../../missions/legacy-schedules"
import { missionTombstoneSchema } from "../../missions/mission-document"

const directory = "C:/private-fixture/worktree", projectID = "private-project"

/** The real routes over the real Missions plugin, with OpenCode's sessions, storage and Automations in memory. */
async function fixture() {
  const app = Fastify(), fence = new WorktreeDeletionFence(2_000)
  const storage = new Map<string, any>(), sessions = new Map<string, any>(), automations: any[] = []
  let handlers: any, next = 0
  const session = {
    get: async ({ sessionID }: any) => { if (!sessions.has(sessionID)) throw Object.assign(new Error("Absent"), { _tag: "SessionNotFoundError", sessionID }); return sessions.get(sessionID) },
    create: async (input: any) => { const value = { ...input, projectID, time: { created: 100 } }; sessions.set(input.id, value); return value },
    environment: async () => {}, instructions: { entry: { put: async () => {}, remove: async () => {} } },
    prompt: async () => ({}), synthetic: async () => ({}), hook: async () => ({ dispose: async () => {} }),
    switchAgent: async ({ sessionID, agent }: any) => { sessions.set(sessionID, { ...sessions.get(sessionID), agent }) },
    switchModel: async ({ sessionID, model }: any) => { sessions.set(sessionID, { ...sessions.get(sessionID), model }) },
  }
  const row = (automationID: string) => automations.find(item => item.id === automationID)
  const client: any = {
    config: { get: async () => [] }, session, location: { get: async () => ({ directory, project: { id: projectID } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    experimental: { automation: {
      list: async ({ sessionID }: any) => {
        if (!sessions.has(sessionID)) throw Object.assign(new Error("Session not found"), { _tag: "SessionNotFoundError", sessionID })
        return automations.filter(item => item.sessionID === sessionID).map(item => ({ ...item }))
      },
      create: async (input: any) => { const value = { id: `aut_${++next}`, tz: "UTC", status: "active", runCount: 0, ...input }; automations.push(value); return value },
      pause: async ({ automationID }: any) => { row(automationID).status = "paused" },
      resume: async ({ automationID }: any) => { row(automationID).status = "active" },
      delete: async ({ automationID }: any) => { if (!row(automationID)) throw new Error("Automation not found"); automations.splice(automations.indexOf(row(automationID)), 1) },
    } },
    rpc: () => new Proxy({}, { get: (_, method) => async (input: any) => method === "documentCapabilities" ? { version: 1, automaticStart: true, rootPermissions: true }
      : handlers[method](input, { error: (type: string, message: string, data: any) => { throw Object.assign(new Error(message), { type, data }) } }) }),
  }
  const workspace = { id: "workspace" }, base = { directory }
  const connection = { client, assertCurrent() {} }
  const manager: any = {
    get: () => workspace, list: () => [workspace], getServiceLocation: () => base, getServiceWslDistro: () => undefined,
    getSharedServiceClient: async () => client, getSharedServiceConnection: async () => connection,
    ownsLocation: async (_id: string, location: any) => location.directory === directory,
    getServiceDirectoryForPath: async (_id: string, path: string) => path === directory ? directory : undefined,
    getWorktreeIdentityForPath: async (_id: string, path: string) => path === directory ? "C:/private-fixture/physical" : undefined,
    getSessionEnvironment: async () => ({}),
  }
  const context: any = {
    location: { directory, project: { id: projectID, canonical: directory } }, session,
    storage: { get: async (key: string) => structuredClone(storage.get(key)), set: async (key: string, value: any) => { storage.set(key, structuredClone(value)) },
      scan: async ({ prefix }: any) => ({ entries: [...storage].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })) }) },
    agent: { list: async () => ({ data: [{ id: "fixture", mode: "all" }] }) },
    model: { list: async () => ({ data: [{ providerID: "provider", id: "model", enabled: true, capabilities: { tools: true }, variants: [] }] }) },
    tool: { transform: async () => ({ dispose: async () => {} }) },
    rpc: { register: async (_definition: any, value: any) => { handlers = value; return { dispose: async () => {}, events: { emit: async () => {} } } } },
  }
  const dispose = await setupMissionsPlugin(context, { prompt: async () => ({}), synthetic: async () => ({}) } as any, undefined,
    async (id, input) => createManagedMissionRoot(manager, fence, id, { kind: "create-root", input }, new AbortController().signal) as any)
  registerMissionRoutes(app, { workspaceManager: manager, worktreeDeletionFence: fence, settings: { getProfileScope: () => ({ key: "profile" }) } } as any)
  const url = "/api/workspaces/workspace/missions/calendars"
  const call = async (method: "GET" | "PUT" | "POST" | "DELETE", path = "", payload?: object) => {
    const response = await app.inject({ method, url: url + path, ...(payload === undefined ? {} : { payload }) })
    return { status: response.statusCode, body: response.json() }
  }
  const rpc = client.rpc(), mission = async (missionID: string) => (await rpc.mission({ missionID })).mission
  // An agent's conversation of the project: mission.program reaches the same operation through the private bridge.
  sessions.set("ses_agent", { id: "ses_agent", projectID, location: { directory } })
  const agent = (program: object, sessionID = "ses_agent") => controlAgentMissionProgram({ workspaceManager: manager, worktreeDeletionFence: fence,
    settings: { getProfileScope: () => ({ key: "profile" }) } } as never, sessionID, program, new AbortController().signal) as Promise<any>
  // A schedule the recurring engine left in the plugin's storage, with the native Automation that woke it.
  const legacy = (id: string, extra: Record<string, unknown> = {}, launch: unknown = configuration().launch) => {
    automations.push({ id: `aut_old_${id}`, sessionID: `ses_cn_schedule_${id}`, name: `cm_${id}`, status: "active", runCount: 3, tz: "UTC" })
    storage.set(legacyScheduleKey({ id: projectID, canonical: directory }, id), { id, projectID, projectCanonical: directory, revision: 7, timeGeneration: 1, state: "running", blocked: null, calendars: [{ scheduleID: `aut_old_${id}`, sessionID: `ses_cn_schedule_${id}` }],
      configuration: { ...configuration("Old instructions"), launch, title: `Old ${id}`, roots: [{ mode: "directory-only", directory }], profileID: "profile", executionHost: "local" }, ...extra })
  }
  const stored = (id: string) => storage.get(legacyScheduleKey({ id: projectID, canonical: directory }, id))
  // Deleted the way the recurring engine deletes: what still reads its storage keeps reading it.
  const retired = (id: string) => { const left = stored(id); return "deletedAt" in left && missionTombstoneSchema.safeParse(left).success }
  return { automations, sessions, call, mission, rpc, agent, legacy, stored, retired, missions: async () => (await rpc.list({})).missions as Array<{ id: string; title?: string; runState?: string }>, close: async () => { await app.close(); await dispose() } }
}
const profile = { agent: "fixture", model: { providerID: "provider", id: "model" } }
const configuration = (objective = "Review", when: unknown[] = [{ kind: "cron", expression: "0 9 * * *", zone: "UTC" }]) => ({
  title: "Daily review", objective, template: "custom", taskMode: "native", profiles: { coordinator: profile, roles: { specialist: profile } },
  watchedConversationIDs: [], launch: { when } })

test("saving a programming prepares its Mission, and saving it again before the first launch prepares it anew in the same conversation", async () => {
  const f = await fixture()
  try {
    assert.deepEqual((await f.call("GET")).body, { calendars: [] })
    const saved = await f.call("PUT", "/cal_review", { configuration: configuration() })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const [calendar] = saved.body.calendars
    assert.deepEqual([calendar.id, calendar.title, calendar.paused, calendar.launch, calendar.rules.length], ["cal_review", "Daily review", false, configuration().launch, 1])
    const first = await f.mission(calendar.missionID)
    assert.deepEqual([first.status, first.runState, first.title], ["active", "prepared", "Daily review"])
    assert.equal(f.automations[0].action.args.prepared, first.id)

    const edited = await f.call("PUT", "/cal_review", { configuration: configuration("Review again") })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    const second = await f.mission(edited.body.calendars[0].missionID)
    assert.notEqual(second.id, first.id)
    assert.deepEqual([second.runState, second.coordinatorSessionId, edited.body.calendars.length, f.automations.map(item => item.action.args.objective)],
      ["prepared", first.coordinatorSessionId, 1, ["Review again"]])
    assert.equal(await f.mission(first.id), undefined, "the Mission prepared first is gone")
  } finally { await f.close() }
})

test("a programming edited after its first launch keeps the Mission of that launch", async () => {
  const f = await fixture()
  try {
    const saved = await f.call("PUT", "/cal_review", { configuration: configuration() })
    const prepared = await f.mission(saved.body.calendars[0].missionID)
    // The start is recorded; this fixture delivers no prompt, which the control reports.
    await f.rpc.lifecycle({ missionID: prepared.id, action: "start", requestID: "start", expectedRevision: prepared.revision }).catch(() => {})
    const started = (await f.mission(prepared.id)).runState
    assert.notEqual(started, "prepared")
    const edited = await f.call("PUT", "/cal_review", { configuration: configuration("Review again") })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    assert.equal(edited.body.calendars[0].missionID, prepared.id)
    assert.equal((await f.mission(prepared.id)).runState, started, "the launch under way is left alone")
    assert.equal(f.automations[0].action.args.objective, "Review again")
  } finally { await f.close() }
})

test("a programming is paused, resumed and deleted, and refused with its reason", async () => {
  const f = await fixture()
  try {
    await f.call("PUT", "/cal_review", { configuration: configuration() })
    assert.equal((await f.call("PUT", "/cal_later", { configuration: configuration(), paused: true })).body.calendars.find((item: any) => item.id === "cal_later").paused, true, "created paused")
    await f.call("DELETE", "/cal_later")
    assert.equal((await f.call("POST", "/cal_review/pause")).body.calendars[0].paused, true)
    assert.equal((await f.call("POST", "/cal_review/resume")).body.calendars[0].paused, false)
    const refused = await f.call("PUT", "/cal_other", { configuration: configuration("Review", [{ kind: "mission-completed", missionID: "msn_other" }]) })
    assert.deepEqual([refused.status, refused.body.code, typeof refused.body.reason], [422, "calendar-unsupported", "string"])
    assert.equal((await f.call("PUT", "/cal_review", { configuration: { ...configuration(), unknown: true } })).status, 400)
    assert.deepEqual((await f.call("DELETE", "/cal_review")).body, { calendars: [] })
    assert.deepEqual([(await f.call("DELETE", "/cal_review")).status, (await f.call("POST", "/cal_review/pause")).body.code], [404, "calendar-missing"])
  } finally { await f.close() }
})

test("an agent saves, lists, pauses and deletes a programmed Mission of its conversation's directory", async () => {
  const f = await fixture()
  try {
    assert.deepEqual(await f.agent({ action: "list" }), { programs: [] })
    const saved = await f.agent({ action: "save", id: "cal_agent", configuration: configuration(), paused: true })
    const [program] = saved.programs
    assert.deepEqual([program.id, program.title, program.paused, program.launch, "nextDueAt" in program], ["cal_agent", "Daily review", true, configuration().launch, false])
    assert.equal((await f.mission(program.missionID)).runState, "prepared")
    assert.equal((await f.agent({ action: "save", id: "cal_agent", configuration: configuration("Review again") })).programs.length, 1, "saving again replaces")
    assert.equal((await f.agent({ action: "resume", id: "cal_agent" })).programs[0].paused, false)
    assert.deepEqual(await f.agent({ action: "save", id: "cal_other", configuration: configuration("Review", [{ kind: "mission-completed", missionID: "msn_other" }]) }),
      { refused: "calendar-unsupported", reason: "event" })
    assert.deepEqual(await f.agent({ action: "pause", id: "cal_absent" }), { refused: "calendar-missing" })
    assert.deepEqual(await f.agent({ action: "delete", id: "cal_agent" }), { programs: [] })
    await assert.rejects(f.agent({ action: "list" }, "ses_unknown"), "a conversation outside the project controls nothing")
    for (const invalid of [{ action: "list", id: "cal_agent" }, { action: "save", id: "cal_agent" }, { action: "pause" }, { action: "pause", id: "cal_agent", paused: true }, { action: "save", id: "a b", configuration: configuration() }])
      assert.equal(missionProgramInput.safeParse(invalid).success, false, JSON.stringify(invalid).slice(0, 60))
  } finally { await f.close() }
})

test("the schedules the recurring engine left become programmed Missions, running or paused as they were", async () => {
  const f = await fixture()
  try {
    f.legacy("msn_running", {}); f.legacy("msn_held", { blocked: "failed" }); f.legacy("msn_paused", { state: "paused" })
    f.legacy("msn_busy", { pending: { id: "psg_under_way" } })
    // The conversation one of them named no longer exists: its first launch opens another.
    const named = f.stored("msn_running"); named.configuration.coordinatorSessionID = "ses_deleted"
    const { calendars } = (await f.call("GET")).body
    assert.deepEqual(calendars.map((item: any) => [item.id, item.title, item.paused, item.mission.objective, item.mission.coordinatorSessionID]).sort(),
      [["msn_busy", "Old msn_busy", false, "Old instructions", undefined], ["msn_held", "Old msn_held", true, "Old instructions", undefined], ["msn_paused", "Old msn_paused", true, "Old instructions", undefined],
        ["msn_running", "Old msn_running", false, "Old instructions", undefined]])
    assert.deepEqual(["msn_running", "msn_held", "msn_paused", "msn_busy"].map(f.retired), [true, true, true, true], "the schedules are deleted, the one whose passage was under way too")
    assert.deepEqual(f.automations.map(item => String(item.id)).filter(id => id.startsWith("aut_old_")), [], "their own Automations are gone")
    assert.equal((await f.mission(calendars[0].missionID)).runState, "prepared")
    const count = f.automations.length
    await f.call("GET")
    assert.equal(f.automations.length, count, "taken over once")
  } finally { await f.close() }
})

test("a schedule whose launch criteria do not carry over becomes an ordinary prepared Mission; one already programmed is only removed", async () => {
  const f = await fixture()
  try {
    f.legacy("msn_other", {}, { when: [{ kind: "mission-completed", missionID: "msn_source" }] })
    await f.call("PUT", "/msn_done", { configuration: configuration("Already programmed") })
    assert.equal(f.retired("msn_other"), true, "whatever the operation")
    f.legacy("msn_done", { state: "stopped" })
    const before = f.automations.filter(item => item.action?.args?.calendar === "msn_done").map(item => item.id)
    const { calendars } = (await f.call("GET")).body
    assert.deepEqual(calendars.map((item: any) => [item.id, item.mission.objective]), [["msn_done", "Already programmed"]])
    assert.deepEqual(f.automations.filter(item => item.action?.args?.calendar === "msn_done").map(item => item.id), before, "its programmed Mission is untouched")
    assert.deepEqual([f.retired("msn_other"), f.retired("msn_done")], [true, true])
    const titles = (await f.missions()).map(item => [item.title, item.runState])
    assert.ok(titles.some(([title, state]) => title === "Old msn_other" && state === "prepared"), JSON.stringify(titles))
  } finally { await f.close() }
})

const conversation = (id: string, variant?: string) => ({ id, projectID, location: { directory }, agent: profile.agent, model: { ...profile.model, ...(variant ? { variant } : {}) } })

test("a conversation on another model is saved as the programmed Mission's and takes the coordinator's agent and model", async () => {
  const f = await fixture()
  try {
    f.sessions.set("ses_named", { ...conversation("ses_named", "high"), agent: "other" })
    const saved = await f.call("PUT", "/cal_named", { configuration: { ...configuration(), coordinatorSessionID: "ses_named" } })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal((await f.mission(saved.body.calendars[0].missionID)).coordinatorSessionId, "ses_named")
    assert.deepEqual([f.sessions.get("ses_named").agent, f.sessions.get("ses_named").model], [profile.agent, profile.model])
  } finally { await f.close() }
})

test("a paused programmed Mission whose Mission is gone has one prepared again; a running one is left to its launch", async () => {
  const f = await fixture()
  try {
    f.sessions.set("ses_named", conversation("ses_named"))
    await f.call("PUT", "/cal_lost", { configuration: { ...configuration("Lost"), coordinatorSessionID: "ses_named" }, paused: true })
    const { calendars } = (await f.call("PUT", "/cal_running", { configuration: configuration("Running") })).body
    const gone = Object.fromEntries(calendars.map((item: any) => [item.id, item.missionID]))
    for (const missionID of Object.values(gone) as string[])
      await f.rpc.delete({ missionID, expectedRevision: (await f.mission(missionID)).revision, requestID: `gone_${missionID}`, deleteManagedSessions: false })
    // The conversation it names has changed model since: it takes the coordinator's again.
    f.sessions.set("ses_named", conversation("ses_named", "high"))
    const read = Object.fromEntries((await f.call("GET")).body.calendars.map((item: any) => [item.id, item]))
    const restored = await f.mission(read.cal_lost.missionID)
    assert.notEqual(read.cal_lost.missionID, gone.cal_lost)
    assert.deepEqual([restored.runState, read.cal_lost.mission.objective, restored.coordinatorSessionId === "ses_named", read.cal_lost.paused, read.cal_lost.mission.coordinatorSessionID],
      ["prepared", "Lost", true, true, "ses_named"])
    assert.equal(read.cal_running.missionID, gone.cal_running, "a run may be replacing it")
    const again = Object.fromEntries((await f.call("GET")).body.calendars.map((item: any) => [item.id, item.missionID]))
    assert.equal(again.cal_lost, read.cal_lost.missionID, "prepared once")
  } finally { await f.close() }
})