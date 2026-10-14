import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "./control"
import type { MissionCreateInput, MissionSessionAdapter, NativeMissionSession } from "./control-types"
import { MissionJournal, parseMissionEvent, type MissionStorage } from "./journal"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { authorityIntentSchema, MISSION_AUTHORITY_POLICY } from "./authority-protocol"
import { validateMissionProfileCatalog, type MissionProfiles } from "./playbook-profiles"
import type { MissionJsonValue } from "./model"

const profiles: MissionProfiles = {
  coordinator: { agent: "lead", model: { providerID: "owned", id: "large", variant: "deep" } },
  roles: { research: { agent: "child", model: { providerID: "owned", id: "small", variant: "quick" } } },
}

function fixture() {
  const data = new Map<string, MissionJsonValue>(), sessions = new Map<string, NativeMissionSession>()
  let births = 0, sends = 0, validations = 0, clock = 1
  const storage: MissionStorage = {
    get: async key => structuredClone(data.get(key)),
    set: async (key, value, current) => { current?.(); data.set(key, structuredClone(value)) },
    scan: async ({ prefix }) => ({ entries: [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
  }
  const project = { id: "project-profile", canonical: "/owned", location: { directory: "/owned", workspaceID: "native-root" } }
  const native: MissionSessionAdapter = {
    get: async ({ sessionID }) => {
      const session = sessions.get(sessionID)
      if (!session) throw new Error("Session not found")
      return structuredClone(session)
    },
    create: async input => {
      births++
      const session = { ...input, projectID: project.id }
      sessions.set(input.id, structuredClone(session))
      return structuredClone(session)
    },
    prompt: async () => { sends++ }, synthetic: async () => { sends++ },
  }
  const control = new MissionControl({ project, storage, sessions: native, now: () => clock++,
    validateProfiles: async request => {
      validations++
      validateMissionProfileCatalog(request, { agents: [{ id: "lead", mode: "primary" }, { id: "child", mode: "subagent" }],
        models: [{ providerID: "owned", id: "large", variants: ["deep"] }, { providerID: "owned", id: "small", variants: ["quick"] }] })
    } })
  const input: MissionCreateInput = { requestID: "exact-create", template: "wayfinder", objective: "Bounded profiles", profiles: structuredClone(profiles) }
  const declare = { taskKey: "research-first", title: "Research", brief: "Find one seam", role: "research", blockedBy: [] }
  return { control, input, declare, data, sessions, storage, project, counts: () => ({ births, sends, validations }) }
}

test("creation stores exact coordinator and child-role profiles without any prompt", async () => {
  const f = fixture()
  const result = await f.control.create(f.input)
  assert.deepEqual(result.mission.profiles, profiles)
  assert.deepEqual(f.sessions.get(result.mission.coordinatorSessionId)?.model, profiles.coordinator!.model)
  assert.equal(f.sessions.get(result.mission.coordinatorSessionId)?.agent, "lead")
  const restored = await new MissionJournal(f.storage, f.project.id, f.project.canonical).snapshot()
  assert.deepEqual(restored.missions[0].profiles, profiles)
  result.mission.profiles!.roles!.research.agent = "mutated-display"
  assert.deepEqual((await f.control.snapshot()).missions[0].profiles, profiles)
  assert.deepEqual(f.counts(), { births: 1, sends: 0, validations: 1 })
})

test("creation retry compares complete profiles, including variant and historical absence", async () => {
  const f = fixture()
  const first = await f.control.create(f.input)
  assert.equal((await f.control.create(structuredClone(f.input))).mission.revision, first.mission.revision)
  for (const next of [undefined, {}, { ...profiles, coordinator: { ...profiles.coordinator, model: { providerID: "owned", id: "large", variant: "quick" } } }]) {
    await assert.rejects(f.control.create({ ...f.input, profiles: next }), /different mission/)
  }
  assert.deepEqual(f.counts(), { births: 1, sends: 0, validations: 1 })
})

test("role profiles inherit at declaration and additive revision, with explicit override preserved", async () => {
  const f = fixture()
  const { mission } = await f.control.create(f.input)
  const first = await f.control.declare(mission.coordinatorSessionId, { ...f.declare, missionID: mission.id })
  assert.deepEqual(first.mission.tasks[0].execution, profiles.roles!.research)
  assert.equal((await f.control.declare(mission.coordinatorSessionId, { ...f.declare, missionID: mission.id })).disposition, "existing")
  const explicit = { agent: "child" }
  const next = await f.control.declare(mission.coordinatorSessionId, { ...f.declare, taskKey: "research-explicit", missionID: mission.id, execution: explicit })
  assert.deepEqual(next.mission.tasks[1].execution, explicit)
  const revision = { missionID: mission.id, requestID: "add-profile", expectedRevision: next.mission.revision, reason: "Add next question",
    retireTasks: [], dependencyUpdates: [], addTasks: [{ ...f.declare, taskKey: "research-added" }] }
  const added = await f.control.revise(mission.coordinatorSessionId, revision)
  assert.deepEqual(added.mission.tasks[2].execution, profiles.roles!.research)
  assert.equal((await f.control.revise(mission.coordinatorSessionId, revision)).mission.revision, added.mission.revision)
  assert.equal(f.counts().births, 1)
  assert.equal(f.counts().sends, 0)
})

test("illegal profiles refuse before root creation or native sends", async () => {
  const invalid: MissionProfiles[] = [
    { coordinator: { agent: "child" } },
    { roles: { research: { agent: "lead" } } },
    { roles: { validator: { agent: "child" } } },
    { coordinator: { model: { providerID: "owned", id: "large", variant: "absent" } } },
    { roles: { __unknown: { agent: "child" } } },
  ]
  for (const request of invalid) {
    const f = fixture()
    await assert.rejects(f.control.create({ ...f.input, profiles: request }), /profile/)
    assert.equal(f.counts().births, 0)
    assert.equal(f.counts().sends, 0)
    assert.equal(f.data.size, 0)
  }
})

test("an existing coordinator with a different profile is never switched", async () => {
  const f = fixture()
  f.sessions.set("ses_existing", { id: "ses_existing", projectID: f.project.id, location: f.project.location, agent: "other" })
  await assert.rejects(f.control.create({ ...f.input, coordinatorSessionID: "ses_existing" }), /requested native profile/)
  assert.equal(f.sessions.get("ses_existing")!.agent, "other")
  assert.equal(f.counts().births, 0)
  assert.equal(f.counts().sends, 0)
})

test("historical absent profiles remain absent; malformed durable profiles are refused", () => {
  const event = { version: 1, id: "created", missionID: "mission-profile", projectID: "project-profile", projectCanonical: "/owned",
    type: "mission.created", objective: "Historical", template: "wayfinder", coordinator: { sessionID: "ses_lead", title: "Lead", location: { directory: "/owned" } }, createdAt: 1 }
  assert.equal(Object.prototype.hasOwnProperty.call(parseMissionEvent(event)!, "profiles"), false)
  assert.equal(parseMissionEvent({ ...event, profiles: { roles: { validator: { agent: "child" } } } }), undefined)
  assert.equal(parseMissionEvent({ ...event, profiles: { coordinator: { model: { providerID: "owned", id: "large", forged: true } } } }), undefined)
})

test("native RPC and signed human intent carry the same profile contract", () => {
  assert.ok("profiles" in CODENOMAD_MISSIONS_RPC.methods.create.input.properties)
  assert.ok("profiles" in CODENOMAD_MISSIONS_RPC.methods.create.output.properties.mission.properties)
  const signed = { version: 1, policy: MISSION_AUTHORITY_POLICY, method: "create", missionID: "mission-profile", projectID: "project-profile",
    authorityID: "authority-profile", keyID: "key-profile", profileID: "profile", executionHost: "local", projectCanonical: "/owned",
    namespace: "c8cb8d62-a104-40ca-a9ba-d205c2a4a7cd", coordinatorSessionID: "ses_lead", roots: [{ mode: "directory-only", directory: "/owned" }],
    epoch: 0, expectedRevision: 0, requestID: "signed-create", payload: { objective: "Signed profiles", template: "wayfinder", prepared: true, profiles } }
  assert.deepEqual(authorityIntentSchema.parse(signed).payload, signed.payload)
})
