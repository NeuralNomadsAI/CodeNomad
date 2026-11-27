import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerMissionRoutes } from "./missions"
import { createManagedMissionRoot } from "./mission-root-creation"
import { setupMissionsPlugin } from "../../opencode/missions-plugin"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

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
  }
  const row = (automationID: string) => automations.find(item => item.id === automationID)
  const client: any = {
    config: { get: async () => [] }, session, location: { get: async () => ({ directory, project: { id: projectID } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    experimental: { automation: {
      list: async ({ sessionID }: any) => automations.filter(item => item.sessionID === sessionID).map(item => ({ ...item })),
      create: async (input: any) => { const value = { id: `aut_${++next}`, tz: "UTC", status: "active", runCount: 0, ...input }; automations.push(value); return value },
      pause: async ({ automationID }: any) => { row(automationID).status = "paused" },
      resume: async ({ automationID }: any) => { row(automationID).status = "active" },
      delete: async ({ automationID }: any) => { automations.splice(automations.indexOf(row(automationID)), 1) },
    } },
    rpc: () => new Proxy({}, { get: (_, method) => async (input: any) => method === "documentCapabilities" ? { version: 1, automaticStart: true, rootPermissions: true }
      : handlers[method](input, { error: (type: string, message: string, data: any) => { throw Object.assign(new Error(message), { type, data }) } }) }),
  }
  const workspace = { id: "workspace" }, base = { directory }
  const manager: any = {
    get: () => workspace, list: () => [workspace], getServiceLocation: () => base, getServiceWslDistro: () => undefined,
    getSharedServiceClient: async () => client, getSharedServiceConnection: async () => ({ client, assertCurrent() {} }),
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
  return { automations, sessions, call, mission, rpc, close: async () => { await app.close(); await dispose() } }
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
    assert.equal((await f.call("POST", "/cal_review/pause")).body.calendars[0].paused, true)
    assert.equal((await f.call("POST", "/cal_review/resume")).body.calendars[0].paused, false)
    const refused = await f.call("PUT", "/cal_other", { configuration: configuration("Review", [{ kind: "mission-completed", missionID: "msn_other" }]) })
    assert.deepEqual([refused.status, refused.body.code, typeof refused.body.reason], [422, "calendar-unsupported", "string"])
    assert.equal((await f.call("PUT", "/cal_review", { configuration: { ...configuration(), unknown: true } })).status, 400)
    assert.deepEqual((await f.call("DELETE", "/cal_review")).body, { calendars: [] })
    assert.deepEqual([(await f.call("DELETE", "/cal_review")).status, (await f.call("POST", "/cal_review/pause")).body.code], [404, "calendar-missing"])
  } finally { await f.close() }
})
