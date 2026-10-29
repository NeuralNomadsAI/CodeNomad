import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl, MissionControlError } from "./control"
import type { MissionInputTransport, MissionSessionAdapter, NativeMissionSession } from "./control-types"
import { MISSION_JOURNAL_STORAGE_PREFIX, MissionJournal, parseMissionEvent, type MissionStorage } from "./journal"
import { reduceMissionEvents, type MissionEvent, type MissionJsonValue } from "./model"

class MemoryStorage implements MissionStorage {
  readonly values = new Map<string, MissionJsonValue>()
  async get(key: string) { return this.values.get(key) }
  async set(key: string, value: MissionJsonValue) { this.values.set(key, structuredClone(value)) }
  async scan(options: { prefix: string; after?: string; limit?: number }) {
    const keys = [...this.values.keys()].filter(key => key.startsWith(options.prefix)).sort()
    const start = options.after ? Math.max(0, keys.findIndex(key => key > options.after!)) : 0
    const selected = keys.slice(start, start + (options.limit ?? 100))
    return { entries: selected.map(key => ({ key, value: this.values.get(key)! })),
      next: start + selected.length < keys.length ? selected[selected.length - 1] : undefined }
  }
}

const coordinator = "ses_coordinator"
type Synthetic = Parameters<MissionSessionAdapter["synthetic"]>[0]

function fixture(options: { completedFinalOnly?: boolean } = {}) {
  const sessions = new Map<string, NativeMissionSession>([[coordinator,
    { id: coordinator, projectID: "project-1", title: "Coordinator", location: { directory: "/repo" } }]])
  const adapter: MissionSessionAdapter = {
    get: async ({ sessionID }) => { const session = sessions.get(sessionID); if (!session) throw new Error("not found"); return session },
    create: async input => {
      const session = { id: input.id, projectID: "project-1", title: input.title, location: input.location }
      sessions.set(session.id, session)
      return session
    },
    prompt: async () => {}, synthetic: async () => {},
  }
  const synthetics: Synthetic[] = []
  const transport: MissionInputTransport = { prompt: async () => {}, synthetic: async (_coordinator, input) => { synthetics.push(input) } }
  const storage = new MemoryStorage()
  let now = 1_000
  const control = new MissionControl({ project: { id: "project-1", canonical: "/repo", location: { directory: "/repo" } },
    storage, sessions: adapter, transport, now: () => now++, completedFinalOnly: options.completedFinalOnly })
  const start = async () => (await control.inspect(coordinator, { start: { objective: "Ship the release", template: "custom" } }, "start")).mission!
  const finish = (outcome: "completed" | "blocked" | "failed") =>
    control.report(coordinator, { final: true, outcome, summary: `Ended ${outcome}`, evidence: [], next: [] })
  const current = async () => (await control.snapshot()).missions[0]!
  const events = async () => [...storage.values].filter(([key]) => key.startsWith(MISSION_JOURNAL_STORAGE_PREFIX))
    .map(([, value]) => parseMissionEvent(value)!).sort((left, right) => left.createdAt - right.createdAt)
  return { control, storage, synthetics, start, finish, current, events }
}

const code = (expected: string) => (error: unknown) => error instanceof MissionControlError && error.code === expected

test("a one-time coordinator finishes only as completed and is told to ask the human instead", async () => {
  const f = fixture({ completedFinalOnly: true })
  await f.start()
  for (const outcome of ["failed", "blocked"] as const) {
    await assert.rejects(f.finish(outcome), (error: unknown) => code("invalid-final-outcome")(error)
      && /ask the human through the native question tool/.test((error as Error).message))
  }
  assert.equal((await f.current()).status, "active")
  assert.equal((await f.finish("completed")).mission.status, "completed")
})

test("controls without the one-time rule, like recurring passages, keep failed finishes", async () => {
  const f = fixture()
  await f.start()
  await assert.rejects(f.finish("blocked"), code("invalid-final-outcome"))
  assert.equal((await f.finish("failed")).mission.status, "failed")
})

test("coordinator recovery resumes a failed mission once and nudges its coordinator", async () => {
  const f = fixture()
  await f.start()
  const failed = (await f.finish("failed")).mission
  assert.equal(failed.summary, "Ended failed")
  await assert.rejects(f.control.recover({ missionID: failed.id, expectedRevision: failed.revision, target: "report", taskKey: "none" }),
    code("mission-not-running"))
  await assert.rejects(f.control.recover({ missionID: failed.id, expectedRevision: failed.revision - 1, target: "coordinator" }),
    code("revision-conflict"))

  const { mission } = await f.control.recover({ missionID: failed.id, expectedRevision: failed.revision, target: "coordinator" })
  assert.equal(mission.status, "active")
  assert.equal(mission.summary, undefined, "a resumed mission no longer shows its failed conclusion")
  assert.equal(mission.revision, failed.revision + 1)
  assert.equal(f.synthetics.length, 1)
  assert.match(f.synthetics[0]!.text, /the user has resumed it/)
  assert.deepEqual(f.synthetics[0]?.metadata?.["codenomad.mission"], { version: 1, missionID: failed.id, kind: "recovery",
    target: "coordinator", revision: mission.revision })

  // The click that reopened it cannot reopen or nudge again.
  await assert.rejects(f.control.recover({ missionID: failed.id, expectedRevision: failed.revision, target: "coordinator" }),
    code("revision-conflict"))
  assert.equal(f.synthetics.length, 1)
  assert.equal((await f.events()).filter(event => event.type === "mission.reopened").length, 1)
  assert.equal((await f.finish("completed")).mission.summary, "Ended completed")
})

test("a failed mission whose coordinator joined another active mission is not resumed", async () => {
  const f = fixture()
  await f.start()
  const failed = (await f.finish("failed")).mission
  const other = (await f.control.create({ requestID: "other", objective: "Next release", template: "custom", coordinatorSessionID: coordinator })).mission
  await assert.rejects(f.control.recover({ missionID: failed.id, expectedRevision: failed.revision, target: "coordinator" }),
    code("already-member"))
  const missions = (await f.control.snapshot()).missions
  assert.equal(missions.find(mission => mission.id === failed.id)?.status, "failed")
  assert.equal(missions.find(mission => mission.id === other.id)?.status, "active")
  assert.equal(f.synthetics.length, 0)
  assert.equal((await f.events()).filter(event => event.type === "mission.reopened").length, 0)
})

test("a reopen event resumes only a failure at its exact revision, and a later Stop ends the resumed mission", async () => {
  const f = fixture()
  await f.start()
  const failed = (await f.finish("failed")).mission
  const journal = new MissionJournal(f.storage, "project-1", "/repo")
  const reopen = (expectedRevision: number, id: string) => journal.append({ version: 1, id, type: "mission.reopened",
    missionID: failed.id, projectID: "project-1", expectedRevision, createdAt: 9_000 + expectedRevision })
  await reopen(failed.revision - 1, "evt_stale_reopen")
  assert.equal((await f.current()).status, "failed")
  assert.equal((await f.control.snapshot()).discardedEvents, 1)

  const events = await f.events()
  const stop = (revision: number): MissionEvent => ({ version: 1, id: `evt_stop_${revision}`, type: "mission.control-requested",
    missionID: failed.id, projectID: "project-1", requestID: `stop-${revision}`, expectedRevision: revision, action: "stop",
    targets: [{ sessionID: coordinator, location: { directory: "/repo" } }], createdAt: 20_000 })
  const reduce = (list: MissionEvent[]) => reduceMissionEvents(list).missions[0]!
  assert.equal(reduce([...events, stop(events.length)]).status, "failed", "a Stop after the finish keeps the recorded outcome")

  await reopen(events.length, "evt_reopen")
  const resumed = await f.events()
  assert.equal(reduce(resumed).status, "active")
  assert.equal(reduce([...resumed, stop(resumed.length)]).status, "stopped")
})
