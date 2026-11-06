import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl, MissionControlError } from "./control"
import { MissionCreateNoEffectError } from "./control-error"
import { stableToken } from "./receipt-identity"
import type { MissionInputTransport, MissionSessionAdapter, NativeMissionSession } from "./control-types"
import type { HumanDecisionCandidate, HumanDecisionDiscovery, NativeHumanAnswerGate } from "./human-answer"
import type { MissionStorage } from "./journal"
import type { MissionJsonValue, MissionTask } from "./model"
import { liveContinuations } from "./coordinator-actions"
import { resolveMissionCreationDefaults } from "./profile-defaults"

class MemoryStorage implements MissionStorage {
  readonly values = new Map<string, MissionJsonValue>()
  async get(key: string) { return this.values.get(key) }
  async set(key: string, value: MissionJsonValue) { this.values.set(key, structuredClone(value)) }
  async remove(key: string) { this.values.delete(key) }
  async scan(options: { prefix: string; after?: string; limit?: number }) {
    const keys = [...this.values.keys()].filter(key => key.startsWith(options.prefix)).sort()
    const start = options.after ? Math.max(0, keys.findIndex(key => key > options.after!)) : 0
    const selected = keys.slice(start, start + (options.limit ?? 100))
    return { entries: selected.map(key => ({ key, value: this.values.get(key)! })),
      next: start + selected.length < keys.length ? selected[selected.length - 1] : undefined }
  }
}

const coordinator = "ses_coordinator"

function fixture(options: { transport?: Partial<MissionInputTransport>; humanGate?: NativeHumanAnswerGate;
  validateProfiles?: ConstructorParameters<typeof MissionControl>[0]["validateProfiles"];
  storage?: MemoryStorage; sessions?: Map<string, NativeMissionSession> } = {}) {
  const sessions = options.sessions ?? new Map<string, NativeMissionSession>([[coordinator,
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
  let now = 1_000
  const storage = options.storage ?? new MemoryStorage()
  const transport = options.transport && { prompt: async () => {}, synthetic: async () => {}, ...options.transport } as MissionInputTransport
  const control = new MissionControl({ project: { id: "project-1", canonical: "/repo", location: { directory: "/repo" } },
    storage, sessions: adapter, transport, validateProfiles: options.validateProfiles, humanGate: options.humanGate, now: () => now++ })
  const start = async (template: "wayfinder" | "custom" = "wayfinder") => (await control.inspect(coordinator,
    { start: { objective: "Chart the pilot", template } }, "start")).mission!
  const declare = (taskKey: string, role = "research") =>
    control.declare(coordinator, { taskKey, title: `Task ${taskKey}`, brief: "Bounded work", role, blockedBy: [] })
  const current = async () => (await control.snapshot()).missions.find(mission => mission.coordinatorSessionId === coordinator)!
  return { control, sessions, storage, start, declare, current }
}

test("a stalled inspect-start preference read never holds the project's mutation lock", async () => {
  let started!: () => void, release!: (value: ReturnType<typeof resolveMissionCreationDefaults>) => void
  const reading = new Promise<void>(resolve => { started = resolve })
  const preferences = new Promise<ReturnType<typeof resolveMissionCreationDefaults>>(resolve => { release = resolve })
  const f = fixture({ transport: { resolveCreationDefaults: async () => { started(); return preferences } } })
  const source = (await f.control.create({ requestID: "source", objective: "Source", template: "custom", coordinatorSessionID: coordinator })).mission
  f.sessions.set("ses_waiting", { id: "ses_waiting", projectID: "project-1", location: { directory: "/repo" } })
  const inspect = f.control.inspect("ses_waiting", { start: { objective: "Waiting", template: "custom" } }, "waiting")
  await reading
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const changed = await Promise.race([
      f.control.update({ missionID: source.id, requestID: "unrelated-edit", expectedRevision: source.revision, objective: "Still responsive" }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Preference I/O held the project mutation lock")), 2_000) }),
    ])
    assert.equal(changed.mission.objective, "Still responsive")
  } finally {
    clearTimeout(timer)
    release(resolveMissionCreationDefaults({ template: "custom", preferences: [] }))
    await inspect
  }
})

test("explicit prepare capability refusals release newly recorded choices", async () => {
  const f = fixture({ transport: { prepare: async () => { throw new MissionControlError("Update CodeNomad", "mission-preferences-update-required") } } })
  await f.control.create({ requestID: "source", objective: "Source", template: "custom", coordinatorSessionID: coordinator })
  for (let i = 0; i < 2; i++) {
    await assert.rejects(f.control.prepare(coordinator, { requestID: "old-backend", objective: "Hand-off", template: "custom",
      profiles: { coordinator: {}, roles: { specialist: {} } }, taskMode: "native" }),
    (error: unknown) => error instanceof MissionControlError && error.code === "mission-preferences-update-required")
    assert.equal([...f.storage.values.keys()].some(key => key.includes("/creation-intents/")), false)
  }
})

test("one replacement may merge several retired tasks; it names one of them as its lineage head", async () => {
  const f = fixture()
  await f.start()
  await f.declare("scope-a"); await f.declare("scope-b")
  const revision = (await f.current()).revision
  const merge = { expectedRevision: revision, reason: "Merge both scopes", dependencyUpdates: [],
    retireTasks: [{ taskKey: "scope-a", replacementTaskKey: "common" }, { taskKey: "scope-b", replacementTaskKey: "common" }] }
  const common = { taskKey: "common", title: "Common scope", brief: "Both scopes", role: "research", blockedBy: [] }
  await assert.rejects(f.control.revise(coordinator, { ...merge, requestID: "merge-headless", addTasks: [common] }),
    /Replacement common must name one of the tasks it replaces/)
  const { mission } = await f.control.revise(coordinator, { ...merge, requestID: "merge", addTasks: [{ ...common, replacesTaskKey: "scope-a" }] })
  assert.deepEqual(mission.tasks.filter(task => task.status === "withdrawn").map(task => [task.key, task.replacedByTaskKey]),
    [["scope-a", "common"], ["scope-b", "common"]])
  assert.equal(mission.tasks.find(task => task.key === "common")?.replacesTaskKey, "scope-a")
})

test("an automatic briefing may let the server pick the revision and never duplicates an unchanged milestone", async () => {
  const f = fixture()
  await f.start()
  await f.declare("scope-a")
  const base = (await f.current()).revision
  const brief = { requestID: "auto", summary: "The plan is declared.", achieved: [], ongoing: [], obstacles: [], next: [] }
  const first = await f.control.briefing(coordinator, brief)
  assert.deepEqual([first.mission.briefing?.requestID, first.mission.briefing?.basedOnRevision, first.mission.revision],
    [`auto:${base}`, base, base + 1])
  assert.equal((await f.control.briefing(coordinator, brief)).mission.revision, base + 1, "an identical retry publishes nothing")
  await assert.rejects(f.control.briefing(coordinator, { ...brief, summary: "Something else." }),
    new RegExp(`Nothing changed since the automatic briefing auto:${base}`))
  await f.declare("scope-b")
  const later = await f.control.briefing(coordinator, { ...brief, summary: "Two scopes are planned." })
  assert.equal(later.mission.briefing?.requestID, `auto:${base + 2}`)
  assert.throws(() => f.control.briefing(coordinator, { ...brief, requestID: "ui-request" }), /Invalid briefing revision/,
    "only \"auto\" may omit basedOnRevision")
  const explicit = await f.control.briefing(coordinator, { ...brief, basedOnRevision: base + 3, summary: "Same plan, explicit revision." })
  assert.equal(explicit.mission.briefing?.requestID, `auto:${base + 3}`, "\"auto\" with a revision is still an automatic ID, never literal")
  await assert.rejects(f.control.briefing(coordinator, { ...brief, basedOnRevision: base, summary: "Stale but new content." }),
    (error: any) => error.code === "revision-conflict" && !/Nothing changed/.test(error.message), "a stale explicit revision is never told to skip")
  assert.equal((await f.control.briefing(coordinator, { ...brief, basedOnRevision: base })).mission.revision, base + 4,
    "an identical explicit replay still returns the saved briefing")
})

test("prepare creates a paused hand-off through the backend; its coordinator may read but never control it", async () => {
  let control!: MissionControl
  const requests: unknown[] = []
  const f = fixture({ transport: { prepare: async (coordinatorID, input) => {
    requests.push(input)
    return control.create({ prepared: true, requestID: input.requestID, objective: input.objective, template: input.template,
      profiles: input.profiles, creationDefaults: input.creationDefaults,
      taskMode: input.taskMode, preparedBy: { missionID: input.missionID, coordinatorSessionID: coordinatorID } })
  } } })
  control = f.control
  const source = await f.start()
  const request = { requestID: "pilot", objective: "Run the pilot with the chosen seam", template: "custom" as const }
  const { mission } = await control.prepare(coordinator, request)
  assert.equal(mission.runState, "prepared", "never started")
  assert.deepEqual(mission.preparedBy, { missionId: source.id, coordinatorSessionId: coordinator })
  assert.notEqual(mission.coordinatorSessionId, coordinator)
  assert.equal((await control.prepare(coordinator, request)).mission.id, mission.id, "the same requestID replays the same mission")
  assert.match((requests[0] as { requestID: string }).requestID, /^prepare_/)
  const read = await control.inspect(coordinator, { missionID: mission.id }, "read")
  assert.deepEqual([read.mission?.id, read.actor], [mission.id, null])
  assert.deepEqual((await control.listMissions(coordinator)).map(entry => [entry.missionID, entry.relation]),
    [[mission.id, "prepared"], [source.id, "member"]])
  await assert.rejects(control.declare(coordinator, { missionID: mission.id, taskKey: "work", title: "Work", brief: "No", role: "specialist", blockedBy: [] }),
    /not visible/)
  f.sessions.set("ses_other", { id: "ses_other", projectID: "project-1", title: "Other", location: { directory: "/repo" } })
  await assert.rejects(control.inspect("ses_other", { missionID: mission.id }, "other"), /not visible/)
  const plain = fixture()
  await plain.start()
  await assert.rejects(plain.control.prepare(coordinator, request), /unavailable here/)
})

test("a prepare retry after a lost reply returns the saved hand-off without another backend call", async () => {
  let control!: MissionControl, calls = 0, reads = 0
  let preferences: unknown = [{ template: "all", profiles: { roles: { specialist: { agent: "worker" } } }, taskMode: "independent" }]
  const transport: Partial<MissionInputTransport> = {
    resolveCreationDefaults: async (_sessionID, input) => { reads++; return resolveMissionCreationDefaults({ ...input, preferences }) },
    prepare: async (coordinatorID, input) => {
    calls++
    await control.create({ prepared: true, requestID: input.requestID, objective: input.objective, template: input.template,
      profiles: input.profiles, creationDefaults: input.creationDefaults,
      taskMode: input.taskMode, preparedBy: { missionID: input.missionID, coordinatorSessionID: coordinatorID } })
    throw new Error("Bridge reply lost")
  } }
  const f = fixture({ transport })
  control = f.control
  await f.start()
  const request = { requestID: "pilot", objective: "Run the pilot", template: "custom" as const }
  await assert.rejects(control.prepare(coordinator, request), (error: any) => error.code === "prepare-uncertain")
  const before = structuredClone([...f.storage.values])
  const frozen = resolveMissionCreationDefaults({ template: "custom", preferences })
  const resolvedReads = reads
  for (preferences of [[], { invalid: true }]) {
    control = fixture({ transport, storage: f.storage, sessions: f.sessions }).control
    const { mission } = await control.prepare(coordinator, request)
    assert.deepEqual([calls, reads, mission.runState, mission.objective], [1, resolvedReads, "prepared", "Run the pilot"])
    assert.deepEqual(mission.profiles, frozen.profiles)
    assert.equal(mission.taskMode, "independent")
    assert.deepEqual(mission.creationDefaults, { request: {}, ...frozen })
    assert.deepEqual([...f.storage.values], before)
  }
  await assert.rejects(control.prepare(coordinator, { ...request, objective: "A different pilot" }), /already prepared a different mission/)
  await assert.rejects(control.prepare(coordinator, { ...request, profiles: {} }), /already prepared a different mission/)
  await assert.rejects(control.prepare(coordinator, { ...request, taskMode: "independent" }), /already prepared a different mission/)
  assert.equal(calls, 1)
  assert.equal(reads, resolvedReads, "conflicting requests also leave preferences unread")
})

test("a definite refusal releases its choice and the same request can use corrected preferences", async () => {
  let control!: MissionControl, refused = false, reads = 0
  let worker = "worker-before"
  const f = fixture({ transport: {
    resolveCreationDefaults: async (_id, input) => { reads++; return resolveMissionCreationDefaults({ ...input,
      preferences: [{ template: "all", profiles: { roles: { specialist: { agent: worker } } } }] }) },
    prepare: async (coordinatorID, input) => {
      if (!refused) { refused = true; throw new MissionControlError("Nothing created", "prepare-refused") }
      return control.create({ ...input, prepared: true, preparedBy: { missionID: input.missionID, coordinatorSessionID: coordinatorID } })
    },
  } })
  control = f.control
  await f.start()
  const request = { requestID: "refused", objective: "Pilot", template: "custom" as const }
  await assert.rejects(control.prepare(coordinator, request), /Nothing created/)
  const previousReads = reads
  worker = "worker-after"
  const result = await control.prepare(coordinator, request)
  assert.equal(reads, previousReads + 1)
  assert.deepEqual(result.mission.creationDefaults?.profiles?.roles?.specialist, { agent: "worker-after" })
})

test("inspect start freezes resolved choices and replays them after preference failure and reinstantiation", async () => {
  let preferences: unknown = [{ template: "all", profiles: { coordinator: { agent: "lead" }, roles: { specialist: { agent: "worker" } } }, taskMode: "independent" }]
  let reads = 0
  const transport: Partial<MissionInputTransport> = { resolveCreationDefaults: async (_sessionID, input) => {
    reads++; return resolveMissionCreationDefaults({ ...input, preferences })
  } }
  const f = fixture({ transport })
  f.sessions.set(coordinator, { ...f.sessions.get(coordinator)!, agent: "lead" })
  const start = { objective: "Frozen selection", template: "custom" as const }
  const first = await f.control.inspect(coordinator, { start }, "frozen-start")
  const selection = resolveMissionCreationDefaults({ ...start, preferences })
  assert.deepEqual(first.selection, selection)
  assert.deepEqual(first.mission?.creationDefaults, { request: {}, ...selection })
  const before = structuredClone([...f.storage.values])
  preferences = { invalid: true }
  const restarted = fixture({ transport, storage: f.storage, sessions: f.sessions }).control
  assert.deepEqual(await restarted.inspect(coordinator, { start }, "frozen-start"), first)
  await assert.rejects(restarted.inspect(coordinator, { start: { ...start, profiles: {} } }, "frozen-start"), /different mission/)
  await assert.rejects(restarted.inspect(coordinator, { start: { ...start, taskMode: "independent" } }, "frozen-start"), /different mission/)
  assert.equal(reads, 1)
  assert.deepEqual([...f.storage.values], before)
})

test("resolved coordinator mismatches and identical preferred Compare models fail before persistence or prepare", async () => {
  const preferences = [{ template: "all", profiles: { coordinator: { agent: "lead" } } }]
  const f = fixture({ transport: { resolveCreationDefaults: async (_sessionID, input) => resolveMissionCreationDefaults({ ...input, preferences }) } })
  await assert.rejects(f.control.inspect(coordinator, { start: { objective: "Mismatch", template: "custom" } }, "mismatch"), /Missions preferences.*profiles\.coordinator.*\{\}/)
  assert.equal(f.storage.values.size, 0)
  const model = { providerID: "p", id: "same" }
  const compare = fixture({ transport: {
    resolveCreationDefaults: async (_sessionID, input) => resolveMissionCreationDefaults({ ...input, preferences: [
      { template: "compare", profiles: { roles: { "model-a": { model }, "model-b": { model } } } },
    ] }),
    prepare: async () => assert.fail("Invalid Compare must never reach preparation"),
  } })
  await assert.rejects(compare.control.inspect(coordinator, { start: { objective: "Compare", template: "compare" } }, "compare"), /compare-models-identical/)
  assert.equal(compare.storage.values.size, 0)
  await compare.start("custom")
  const before = structuredClone([...compare.storage.values])
  await assert.rejects(compare.control.prepare(coordinator, { requestID: "compare", objective: "Compare", template: "compare" }), /compare-models-identical/)
  assert.deepEqual([...compare.storage.values], before)
})

test("inspect Compare freezes the known coordinator model for an omitted judge across native model changes", async () => {
  let reads = 0
  const f = fixture({ transport: { resolveCreationDefaults: async (_id, input) => {
    reads++; return resolveMissionCreationDefaults({ ...input, preferences: [] })
  } } })
  f.sessions.get(coordinator)!.model = { providerID: "p", id: "coordinator-x", variant: "default" }
  const start = { objective: "Compare", template: "compare" as const, profiles: { roles: {
    "model-a": { model: { providerID: "p", id: "a" } }, "model-b": { model: { providerID: "p", id: "b" } },
  } } }
  const result = await f.control.inspect(coordinator, { start }, "known-coordinator")
  assert.deepEqual(result.selection?.profiles.roles?.comparator, { model: { providerID: "p", id: "coordinator-x" } })
  assert.equal(result.selection?.origins.roles.comparator, "opencode-default")
  f.sessions.get(coordinator)!.model = { providerID: "p", id: "native-default-y" }
  assert.deepEqual((await f.control.inspect(coordinator, { start }, "known-coordinator")).selection, result.selection)
  assert.equal(reads, 1)
})

test("prepare outside a mission points to the editor without resolving preferences or creating anything", async () => {
  const f = fixture({ transport: {
    resolveCreationDefaults: async () => assert.fail("No preference read outside a mission"),
    prepare: async () => assert.fail("No preparation outside a mission"),
  } })
  await assert.rejects(f.control.prepare(coordinator, { requestID: "pilot", objective: "Pilot", template: "custom" }), /Missions editor.*do not create a mission only to prepare others/)
  assert.equal(f.storage.values.size, 0)
  assert.equal(f.sessions.size, 1)
})

test("128 definite preparation refusals leave capacity available for the next request", async () => {
  for (const certificate of [false, true]) {
    let control!: MissionControl, refuse = true
    const f = fixture({ transport: {
      resolveCreationDefaults: async (_id, input) => resolveMissionCreationDefaults({ ...input, preferences: [] }),
      prepare: async (id, input) => {
        if (refuse) {
          if (certificate) throw new MissionCreateNoEffectError(input.requestID, `msn_${stableToken(`project-1\0${input.requestID}`, 24)}`)
          throw new MissionControlError("Nothing created", "prepare-refused")
        }
        return control.create({ ...input, prepared: true, preparedBy: { missionID: input.missionID, coordinatorSessionID: id } })
      },
    } })
    control = f.control
    await f.start("custom")
    for (let index = 0; index < 128; index++) {
      await assert.rejects(control.prepare(coordinator, { requestID: `refused-${index}`, objective: "Pilot", template: "custom" }),
        (error: any) => error.code === (certificate ? "request-conflict" : "prepare-refused"))
    }
    assert.equal([...f.storage.values.keys()].filter(key => key.includes("/creation-intents/")).length, 0)
    refuse = false
    assert.equal((await control.prepare(coordinator, { requestID: "allowed", objective: "Pilot", template: "custom" })).mission.runState, "prepared")
  }
})

test("an explicit cross-playbook profile fails before reading user preferences", async () => {
  const f = fixture({ transport: {
    resolveCreationDefaults: async () => assert.fail("The agent must correct its own input first"),
    prepare: async () => assert.fail("Invalid input cannot reach preparation"),
  } })
  await f.control.create({ requestID: "source", objective: "Source", template: "custom", coordinatorSessionID: coordinator })
  const before = structuredClone([...f.storage.values])
  await assert.rejects(f.control.prepare(coordinator, { requestID: "bad", objective: "Debug", template: "debug", profiles: { roles: { specialist: {} } } }),
    (error: any) => error.code === "invalid-execution" && !/preferences/.test(error.message))
  assert.deepEqual([...f.storage.values], before)
})

test("both creation tools bypass preferences when every slot and the task policy are explicit", async () => {
  for (const method of ["inspect", "prepare"] as const) {
    let control!: MissionControl, prepares = 0
    const f = fixture({ transport: {
      resolveCreationDefaults: async () => assert.fail("Unused preferences must not be read"),
      prepare: async (id, input) => { prepares++; return control.create({ ...input, prepared: true,
        preparedBy: { missionID: input.missionID, coordinatorSessionID: id } }) },
    } })
    control = f.control
    if (method === "prepare") await control.create({ requestID: "source", objective: "Source", template: "custom", coordinatorSessionID: coordinator })
    const input = { objective: "Explicit", template: "custom" as const, taskMode: "native" as const,
      profiles: { coordinator: {}, roles: { specialist: {} } } }
    const result = method === "inspect" ? await control.inspect(coordinator, { start: input }, "explicit")
      : await control.prepare(coordinator, { ...input, requestID: "explicit" })
    assert.deepEqual(result.mission!.creationDefaults?.origins, { coordinator: "explicit", roles: { specialist: "explicit" }, taskMode: "explicit" })
    assert.equal(result.mission!.creationDefaults?.preferences, undefined)
    assert.equal(prepares, method === "prepare" ? 1 : 0, "only hand-off creation still requires its backend")
  }
})

test("an explicit empty coordinator slot overrides a mismatching coordinator preference", async () => {
  const f = fixture({ transport: { resolveCreationDefaults: async (_id, input) => resolveMissionCreationDefaults({ ...input,
    preferences: [{ template: "all", profiles: { coordinator: { agent: "other" } } }] }) } })
  const result = await f.control.inspect(coordinator, { start: { objective: "Explicit default", template: "custom", profiles: { coordinator: {} } } }, "override")
  assert.deepEqual(result.selection?.profiles.coordinator, {})
  assert.equal(result.selection?.origins.coordinator, "explicit")
})

test("a failed local catalog preflight cannot relabel an earlier unknown preparation", async () => {
  let failCatalog = false, calls = 0, reads = 0
  const f = fixture({
    validateProfiles: async () => { if (failCatalog) throw new Error("Catalog unavailable") },
    transport: {
      resolveCreationDefaults: async (_id, input) => { reads++; return resolveMissionCreationDefaults({ ...input, preferences: [] }) },
      prepare: async () => { calls++; throw new MissionControlError("Unknown native outcome", "prepare-uncertain") },
    },
  })
  await f.start("custom")
  const request = { requestID: "unknown", objective: "Pilot", template: "custom" as const }
  await assert.rejects(f.control.prepare(coordinator, request), (error: any) => error.code === "prepare-uncertain")
  const previousReads = reads
  failCatalog = true
  await assert.rejects(f.control.prepare(coordinator, request), (error: any) => error.code === "prepare-uncertain")
  await assert.rejects(f.control.prepare(coordinator, { ...request, objective: "Another pilot" }), (error: any) => error.code === "prepare-conflict")
  assert.equal(reads, previousReads)
  assert.equal(calls, 1)
  assert.equal([...f.storage.values.keys()].filter(key => key.includes("/creation-intents/")).length, 1)
})

test("a retired native task's conversations are observed and stopped only through validated bridge replies", async () => {
  const calls: unknown[] = []
  let reply: unknown = { sessions: [{ sessionID: "ses_child", interrupted: true, settled: true,
    descendants: { observed: 1, interrupted: 1, cancelled: 0, unconfirmed: 0, complete: true, sessions: ["ses_grandchild"] } }], complete: true }
  const f = fixture({ transport: {
    observeTask: async (coordinatorID, input) => { calls.push(["observe", coordinatorID, input]); return { sessions: [{ sessionID: "ses_child", active: true }], complete: true } },
    interruptTask: async (coordinatorID, input) => { calls.push(["interrupt", coordinatorID, input]); return reply },
  } })
  const mission = await f.start()
  await f.declare("scope-a")
  assert.deepEqual(await f.control.observeTask(coordinator, undefined, "scope-a"), { sessions: [{ sessionID: "ses_child", active: true }], complete: true })
  await assert.rejects(f.control.interruptTask(coordinator, { taskKey: "scope-a" }), /Retire the task with mission.revise/)
  await f.control.revise(coordinator, { expectedRevision: (await f.current()).revision, requestID: "retire", reason: "Superseded",
    retireTasks: [{ taskKey: "scope-a" }], addTasks: [], dependencyUpdates: [] })
  const stopped = await f.control.interruptTask(coordinator, { taskKey: "scope-a" })
  assert.equal(stopped.complete, true)
  assert.deepEqual(calls[calls.length - 1], ["interrupt", coordinator, { missionID: mission.id, taskKey: "scope-a" }])
  reply = { sessions: [], complete: true }
  assert.match((await f.control.interruptTask(coordinator, { taskKey: "scope-a" })).note ?? "", /another prompt is not visible here/,
    "an empty result is never presented as proof that nothing runs")
  reply = { sessions: [{ sessionID: "ses_child", interrupted: true, settled: true, raw: "native error with secrets" }], complete: true }
  await assert.rejects(f.control.interruptTask(coordinator, { taskKey: "scope-a" }))
  await assert.rejects(f.control.interruptTask(coordinator, { taskKey: "missing" }), /Mission task not found/)
  const plain = fixture()
  await plain.start(); await plain.declare("scope-a")
  assert.equal(await plain.control.observeTask(coordinator, undefined, "scope-a"), undefined, "no backend, no observation")
})

test("an open task continuing a retired task's conversation keeps that conversation from being stopped", () => {
  const task = (key: string, status: MissionTask["status"], reuseFromTaskKey?: string, parentTaskKey: string | null = null): MissionTask => ({
    id: key, key, title: key, brief: "", role: "specialist", blockedBy: [], status, createdAt: 1, updatedAt: 1, outstandingExecution: false,
    executionMode: { kind: "native", parentTaskKey, ...(reuseFromTaskKey ? { reuseFromTaskKey } : {}) } })
  const tasks = [task("source", "withdrawn"), task("middle", "completed", "source"), task("live", "ready", "middle"), task("done", "completed", "source")]
  assert.deepEqual(liveContinuations(tasks, "source"), ["live"], "a chain through a finished continuation still reaches the open task")
  assert.deepEqual(liveContinuations(tasks.filter(item => item.key !== "live"), "source"), [])
  // A nested task launched under a continuation of the retired conversation runs in its family too.
  assert.deepEqual(liveContinuations([task("scope-a", "withdrawn"), task("scope-b", "completed", "scope-a"),
    task("scope-c", "ready", undefined, "scope-b")], "scope-a"), ["scope-c"])
  assert.deepEqual(liveContinuations([task("scope-a", "withdrawn"), task("nested", "queued", undefined, "scope-a")], "scope-a"), ["nested"])
  assert.deepEqual(liveContinuations([task("a", "ready", "b"), task("b", "ready", "a")], "c"), [], "reuse cycles terminate")
})

function decisionGate(discovery: () => HumanDecisionDiscovery): NativeHumanAnswerGate {
  return Object.assign(async (request: Parameters<NativeHumanAnswerGate>[0]) => ({ formID: request.formID, sessionID: request.sessionID,
    answeredAt: 1, via: "ui" as const, answer: { [request.fieldKey]: request.answer },
    form: { metadata: { kind: "question", tool: { messageID: request.messageID, id: request.toolCallID } } } as never }),
  { discover: async () => discovery() })
}

const candidate = (missionID: string, answer: string): HumanDecisionCandidate => {
  const provenance = { kind: "native-form-answer" as const, contract: { missionID, taskKey: "choose", generation: 1 },
    nativeCall: { generation: 1, parentSessionID: coordinator, parentMessageID: "msg_parent", toolCallID: "call_subagent" },
    sessionID: "ses_decision", formID: `frm_${answer}`, messageID: "msg_question", toolCallID: "call_question", fieldKey: "q0" }
  return { question: "Which seam?", answer, askedBy: "decision-task", artifact: { kind: "decision", question: "Which seam?", answer, provenance } }
}

test("a decision readout without an artifact uses the single qualifying human answer, still verified by the gate", async () => {
  let found: HumanDecisionCandidate[] = [], complete = true
  const f = fixture({ humanGate: decisionGate(() => ({ candidates: found, complete })) })
  const mission = await f.start()
  f.sessions.set("ses_decision", { id: "ses_decision", parentID: coordinator, projectID: "project-1", location: { directory: "/repo" } })
  await f.declare("choose", "decision")
  const readout = { taskKey: "choose", outcome: "completed" as const, summary: "The human chose the module seam.", evidence: [], next: [], final: false }
  await assert.rejects(f.control.report(coordinator, readout), /Decision outcome required: no answered question qualifies.*"decidedBy":"coordinator"/)
  found = [candidate(mission.id, "Module"), candidate(mission.id, "Adapter")]
  await assert.rejects(f.control.report(coordinator, readout), /Several answered questions qualify/)
  assert.deepEqual((await f.control.decisionCandidates(coordinator, undefined, "choose"))?.candidates.map(item => item.answer), ["Module", "Adapter"])
  found = [found[0]]
  complete = false
  await assert.rejects(f.control.report(coordinator, readout), /Not every answered question could be checked/,
    "an incomplete discovery never picks its only visible answer")
  complete = true
  const reported = await f.control.report(coordinator, readout)
  assert.equal(reported.disposition, "reported")
  assert.deepEqual(reported.mission.tasks.find(task => task.key === "choose")?.report?.artifact, found[0].artifact)
  assert.equal(await f.control.decisionCandidates(coordinator, undefined, "missing"), undefined)
})
