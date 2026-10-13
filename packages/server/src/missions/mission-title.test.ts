import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "./control"
import type { NativeMissionSession } from "./control-types"
import { MissionCreateNoEffectError } from "./control-error"
import { parseMissionEvent, type MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { MISSION_TITLE_MAX, deriveMissionTitle, missionCoordinatorTitle, parseMissionTitle } from "./mission-title"
import { missionCreationRequestSchema } from "../server/routes/mission-creation-pipeline"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = {
    get: async key => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit }) => {
      const entries = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => ({ key, value }))
      return { entries, next: entries.length === limit ? entries.at(-1)?.key : undefined }
    },
  }
  const native = new Map<string, NativeMissionSession>()
  let now = 1_000
  const control = () => new MissionControl({ project: { id: "project", canonical: "/repo", location: { directory: "/repo" } }, storage,
    now: () => now++, sessions: {
      get: async ({ sessionID }) => { if (!native.has(sessionID)) throw new Error("missing"); return native.get(sessionID)! },
      create: async input => { const session = { ...input, projectID: "project" }; native.set(session.id, session); return session },
      prompt: async () => { throw new Error("unused") }, synthetic: async () => { throw new Error("unused") },
    } })
  return { control, values, native }
}

test("title rule trims, bounds at 60 and refuses multi-line labels", () => {
  assert.equal(parseMissionTitle("  Ship the release  "), "Ship the release")
  assert.equal(parseMissionTitle("x".repeat(MISSION_TITLE_MAX)), "x".repeat(60))
  for (const bad of ["", "   ", "x".repeat(61), "two\nlines", 42]) assert.equal(parseMissionTitle(bad), undefined)
  const schema = missionCreationRequestSchema
  const base = { objective: "Do it", template: "custom", requestId: "req" }
  assert.equal(schema.parse({ ...base, title: "  Short  " }).title, "Short")
  assert.equal(schema.safeParse({ ...base, title: "x".repeat(61) }).success, false)
  assert.equal(schema.safeParse({ ...base, title: "" }).success, false)
  assert.equal(schema.parse(base).title, undefined)
  const rpcTitle = (CODENOMAD_MISSIONS_RPC.methods.create.input.properties as Record<string, { maxLength?: number }>).title
  assert.equal(rpcTitle?.maxLength, MISSION_TITLE_MAX)
})

test("derived titles use the first sentence or clause within the bound", () => {
  assert.equal(deriveMissionTitle("Fix the login bug. Then add tests."), "Fix the login bug")
  assert.equal(deriveMissionTitle("\n\n  Review open PRs; merge green ones\nmore"), "Review open PRs")
  const long = deriveMissionTitle("word ".repeat(40))
  assert.ok(long.length <= MISSION_TITLE_MAX && long.endsWith("…"))
  assert.equal(missionCoordinatorTitle("Nightly audit", "ignored"), "Mission · Nightly audit")
  assert.equal(missionCoordinatorTitle(undefined, "Audit dependencies. Report."), "Mission · Audit dependencies")
})

test("creation persists and exposes the title, names the coordinator and rejects a changed replay", async () => {
  const f = fixture()
  const { mission } = await f.control().create({ requestID: "titled", title: " Release prep ", objective: "Prepare the release.", template: "custom", prepared: true })
  assert.equal(mission.title, "Release prep")
  assert.equal(f.native.get(mission.coordinatorSessionId)?.title, "Mission · Release prep")
  const stored = [...f.values.values()].map(parseMissionEvent).find(event => event?.type === "mission.created")
  assert.equal(stored?.type === "mission.created" && stored.title, "Release prep")
  assert.equal((await f.control().snapshot()).missions[0]!.title, "Release prep")
  assert.equal((await f.control().create({ requestID: "titled", title: "Release prep", objective: "Prepare the release.", template: "custom", prepared: true })).mission.id, mission.id)
  await assert.rejects(f.control().create({ requestID: "titled", title: "Other", objective: "Prepare the release.", template: "custom", prepared: true }),
    (error: unknown) => error instanceof MissionCreateNoEffectError)
  await assert.rejects(f.control().create({ requestID: "bad", title: "x".repeat(61), objective: "Bad", template: "custom", prepared: true }))
})

test("historical missions without a title stay untitled", async () => {
  const f = fixture()
  const { mission } = await f.control().create({ requestID: "plain", objective: "Audit dependencies. Report findings.", template: "custom", prepared: true })
  assert.equal("title" in mission, false)
  assert.equal(f.native.get(mission.coordinatorSessionId)?.title, "Mission · Audit dependencies")
  const created = [...f.values.values()].find(value => (value as { type?: string }).type === "mission.created") as Record<string, MissionJsonValue>
  assert.equal("title" in created, false)
  assert.equal(parseMissionEvent({ ...created, title: "x".repeat(61) }), undefined, "the journal refuses an oversized stored title")
  assert.equal(parseMissionEvent({ ...created, title: " padded " }), undefined, "the journal refuses an unnormalized stored title")
})
