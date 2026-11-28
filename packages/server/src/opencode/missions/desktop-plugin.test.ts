import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MISSION_JOURNAL_STORAGE_PREFIX } from "../../missions/journal"
import { desktopPlugin } from "./desktop-plugin"
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
    const cleanup = await desktopPlugin(directory, undefined, undefined, () => requestRange).setup({
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
      assert.deepEqual(tools, ["inspect", "delegate", "revise", "report", "briefing", "interrupt", "prepare", "program", "settings", "control", "configure", "delete", "mission_calendar_run"])
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