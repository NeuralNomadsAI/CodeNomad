import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MISSION_JOURNAL_STORAGE_PREFIX } from "../../missions/journal"
import { desktopPlugin } from "./desktop-plugin"
import type { NativeMissionSession } from "../../missions/control-types"
import type { MissionJsonValue } from "../../missions/model"
import { MissionControl } from "../../missions/control"
import type { NativeJournalRange } from "./native-journal-range"

const RETIRED = "codenomad-missions/authority-"

test("presence-owned setup registers one-time Missions without touching the retired authority namespace", async () => {
  const temporary = path.join(os.tmpdir(), "opencode")
  await mkdir(temporary, { recursive: true })
  const directory = await mkdtemp(path.join(temporary, "missions-retired-authority-"))
  await writeFile(path.join(directory, "abc.lease"), "")
  const tools: string[] = [], touched: string[] = []
  // Old stored bytes, damaged and well-formed alike, must stay unread and unchanged.
  const old = new Map<string, unknown>([[`${RETIRED}v2/namespace`, "damaged"], [`${RETIRED}v2/project/x`, { grants: [] }]])
  const values = new Map<string, unknown>(old)
  const trap = (key: string) => {
    touched.push(key)
    if (key.startsWith(RETIRED)) throw new Error(`Retired authority namespace accessed: ${key}`)
  }
  const registrations = { dispose: async () => {} }
  let snapshot: (() => Promise<unknown>) | undefined
  let rangeReads = 0
  let requestRange: NativeJournalRange | undefined
  const range: NativeJournalRange = {
    listRanges: async () => { rangeReads++; return { missionIDs: [], stray: 0 } },
    readOrdered: async () => assert.fail("no mission ranges"),
    readEvent: async () => assert.fail("no events"),
  }
  try {
    const cleanup = await desktopPlugin(directory, undefined, undefined, undefined, () => requestRange).setup({
      location: { directory: directory, project: { id: "owned-project", canonical: directory } },
      storage: {
        get: async (key: string) => { trap(key); return values.get(key) },
        set: async (key: string, value: unknown) => { trap(key); values.set(key, value) },
        remove: async (key: string) => { trap(key); values.delete(key) },
        scan: async () => assert.fail("qualified ordinary RPC must use the range reader"),
      },
      session: { hook: async () => registrations },
      rpc: { register: async (_: unknown, handlers: { snapshot(): Promise<unknown> }) => {
        snapshot = handlers.snapshot
        return { ...registrations, events: { emit: async () => {} } }
      } },
      tool: { transform: async (callback: (draft: { namespace(): void; add(input: { name: string }): void }) => void) => {
        callback({ namespace: () => {}, add: item => { tools.push(item.name) } })
        return registrations
      } },
    } as never)
    assert.equal(typeof cleanup, "function")
    try {
      assert.deepEqual(tools, ["inspect", "delegate", "revise", "report", "briefing", "interrupt", "prepare", "schedule", "settings", "control", "configure", "delete", "mission_calendar_run"])
      requestRange = range
      assert.deepEqual((await snapshot!() as { missions: unknown[] }).missions, [])
      assert.ok(rangeReads > 0)
    } finally { await cleanup?.() }
    assert.deepEqual(touched.filter(key => key.startsWith(RETIRED)), [], "no retired namespace read, create or repair")
    assert.ok(touched.every(key => key.startsWith(`${MISSION_JOURNAL_STORAGE_PREFIX}/`) || key === MISSION_JOURNAL_STORAGE_PREFIX
      || key.startsWith("codenomad-missions/registered-v1/")), touched.join(", "))
    for (const [key, value] of old) assert.deepEqual(values.get(key), value)
    assert.equal([...values.keys()].filter(key => key.startsWith(RETIRED)).length, old.size, "nothing created under the old namespace")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("passage configuration list, ID and slices use the ordinary owning backend", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode", "missions-config-routing-"))
  await writeFile(path.join(directory, "abc.lease"), "")
  const sessionID = "ses_passage", tools = new Map<string, any>(), registration = { dispose: async () => {} }
  const session = { id: sessionID, projectID: "project", location: { directory } }
  const storage = { get: async () => undefined, set: async () => assert.fail("Read-only"), scan: async () => ({ entries: [] }) }
  const sessions = { get: async () => session, create: async () => assert.fail("Read-only"),
    prompt: async () => assert.fail("Read-only"), synthetic: async () => assert.fail("Read-only") }
  const passage = new MissionControl({ project: { id: "project", canonical: directory, location: { directory } }, storage, sessions,
    transport: { prompt: async () => {}, synthetic: async () => {} } })
  const saved = { version: 1, id: "00000000-0000-4000-8000-000000000001", name: "Saved",
    objective: "\0".repeat(20_000), notes: "\0".repeat(20_000), template: "custom" }
  const original = MissionControl.prototype.savedConfigurations
  MissionControl.prototype.savedConfigurations = async function (id) {
    if (this === passage) return original.call(this, id)
    assert.equal(id, sessionID)
    return [saved] as never
  }
  let sourceReads = 0
  let cleanup: Awaited<ReturnType<ReturnType<typeof desktopPlugin>["setup"]>>
  try {
    cleanup = await desktopPlugin(directory, undefined, undefined, {
      prepare: async () => true, select: async () => {
        sourceReads++
        return { control: passage, readSessionID: sessionID, current() {}, beforeTool: async () => {} }
      },
    }).setup({ location: { directory, project: { id: "project", canonical: directory } }, storage,
      session: { ...sessions, hook: async () => registration },
      rpc: { register: async () => ({ ...registration, events: { emit: async () => {} } }) },
      tool: { transform: async (callback: any) => {
        callback({ namespace() {}, add: (tool: any) => tools.set(tool.name, tool) }); return registration
      } },
    } as never)
    const inspect = async (input: unknown) => JSON.parse((await tools.get("inspect").execute(input,
      { sessionID, messageID: "msg_config", id: "call_config", progress: async () => {} })).content)
    assert.deepEqual((await inspect({ configurations: true })).configurations, [{ id: saved.id, name: saved.name, template: saved.template }])
    const full = await inspect({ configurations: saved.id })
    assert.ok(full.configuration.read)
    let read = full.configuration.read, text = ""
    while (read) {
      const slice = await inspect(read)
      text += slice.content.text
      read = slice.content.next
    }
    assert.deepEqual(JSON.parse(text), { ...saved, title: saved.name })
    assert.equal(sourceReads, 0)
  } finally {
    MissionControl.prototype.savedConfigurations = original
    await cleanup!?.()
    await rm(directory, { recursive: true, force: true })
  }
})

test("passage authors use ordinary preparation and authored reads while their source list and coordination stay isolated", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode", "missions-preparation-routing-"))
  await writeFile(path.join(directory, "abc.lease"), "")
  const author = "ses_child", root = "ses_root", source = "msn_passage"
  const sessions = new Map<string, NativeMissionSession>([
    [root, { id: root, projectID: "project", location: { directory }, metadata: { "codenomad.mission": {
      kind: "coordinator", missionID: source, document: { missionID: "schedule", passageID: "passage" } } } }],
    [author, { id: author, parentID: root, projectID: "project", location: { directory } }],
  ])
  const values = new Map<string, MissionJsonValue>(), tools = new Map<string, any>(), hooks = new Map<string, any>()
  const registration = { dispose: async () => {} }
  let handlers: any, sourceReads = 0
  const cleanup = await desktopPlugin(directory, undefined, undefined, {
    prepare: async () => true,
    select: async () => {
      sourceReads++
      return { readSessionID: root, current() {}, beforeTool: async () => {},
        control: {
          backendActions: false,
          contextFor: async () => ({ missionID: source, coordinator: true, instruction: "Source instructions", paused: false }),
          inspectTool: async () => ({ missions: [{ missionID: source, relation: "member", template: "custom",
            status: "active", revision: 1, createdAt: 1 }] }),
        } } as never
    },
  }).setup({
    location: { directory, project: { id: "project", canonical: directory } },
    storage: {
      get: async (key: string) => structuredClone(values.get(key)),
      set: async (key: string, value: MissionJsonValue) => { values.set(key, structuredClone(value)) },
      scan: async ({ prefix }: { prefix: string }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => { const value = sessions.get(sessionID); assert.ok(value); return value },
      create: async (input: NativeMissionSession) => { const value = { ...input, projectID: "project" }; sessions.set(value.id, value); return value },
      hook: async (name: string, callback: unknown) => { hooks.set(name, callback); return registration },
    },
    rpc: { register: async (_: unknown, value: unknown) => { handlers = value; return { ...registration, events: { emit: async () => {} } } } },
    tool: { transform: async (callback: any) => { callback({ namespace() {}, add: (tool: any) => tools.set(tool.name, tool) }); return registration } },
  } as never)
  try {
    const target = await handlers.create({ requestID: "prepared", objective: "Separate", template: "custom", prepared: true,
      preparedBy: { missionID: source, coordinatorSessionID: author } }, { error: () => assert.fail("Creation rejected") })
    const tool = { sessionID: author, messageID: "msg_test", id: "call_test", progress: async () => {} }
    const before = sourceReads
    const refused = JSON.parse((await tools.get("prepare").execute({ requestID: "invalid", objective: "No dispatch", template: "debug",
      profiles: { roles: { specialist: {} } } }, tool)).content)
    assert.equal(refused.code, "invalid-execution", "ordinary author admission, before any backend request")
    assert.equal(sourceReads, before, "preparation never selects the passage runtime")
    const read = JSON.parse((await tools.get("inspect").execute({ missionID: target.mission.id }, tool)).content)
    assert.equal(read.mission.id, target.mission.id)
    assert.equal(read.actor, null)
    assert.equal(sourceReads, before, "authored target reads stay in the ordinary journal")
    const list = JSON.parse((await tools.get("inspect").execute({ list: true }, tool)).content)
    assert.deepEqual(list.missions.map((mission: any) => [mission.missionID, mission.relation]),
      [[target.mission.id, "prepared"], [source, "member"]])
    const event = { sessionID: author, system: [], tools: { mission_prepare: {}, mission_delegate: {}, mission_report: {}, mission_interrupt: {} } }
    await hooks.get("context")(event)
    assert.ok(event.tools.mission_prepare)
    assert.equal(event.tools.mission_delegate, undefined)
    assert.equal(event.tools.mission_report, undefined)
    assert.equal(event.tools.mission_interrupt, undefined)
  } finally { await cleanup?.(); await rm(directory, { recursive: true, force: true }) }
})

test("the calendar tool accepts only an Automation run of a calendar carrier", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode", "missions-calendar-caller-"))
  const tools = new Map<string, any>(), registration = { dispose: async () => {} }, removed: string[] = []
  const metadata = new Map<string, Record<string, unknown>>([["ses_plain", {}], ["ses_carrier", { "codenomad.mission-calendar": { version: 1 } }]])
  const cleanup = await desktopPlugin(directory).setup({ location: { directory, project: { id: "project", canonical: directory } },
    // Registered when the service stopped, but nothing is running: this activation stays unregistered and forgets the key.
    storage: { get: async (key: string) => key.startsWith("codenomad-missions/registered-v1/") ? true : undefined, set: async () => assert.fail("No write"),
      remove: async (key: string) => { removed.push(key) }, scan: async () => ({ entries: [] }) },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, projectID: "project", location: { directory }, metadata: metadata.get(sessionID) }),
      hook: async () => registration },
    rpc: { register: async () => assert.fail("No backend and no run: Missions stays unregistered") },
    tool: { transform: async (callback: any) => { callback({ namespace() {}, add: (tool: any) => tools.set(tool.name, tool) }); return registration } },
  } as never)
  try {
    const run = (sessionID: string, messageID: string) => tools.get("mission_calendar_run").execute({ objective: "Review", template: "custom" },
      { sessionID, messageID, id: "call", progress: async () => {} })
    assert.equal(removed.length, 1)
    assert.match(removed[0]!, /^codenomad-missions\/registered-v1\//)
    await assert.rejects(run("ses_plain", "msg_aut_01ABC_1"), /^Error: mission-calendar-caller$/)
    await assert.rejects(run("ses_carrier", "msg_typed_by_a_model"), /^Error: mission-calendar-caller$/)
    await assert.rejects(run("ses_carrier", "msg_aut_01ABC_1_send"), /^Error: mission-calendar-caller$/)
  } finally { await cleanup?.(); await rm(directory, { recursive: true, force: true }) }
})