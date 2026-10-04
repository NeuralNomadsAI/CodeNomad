import assert from "node:assert/strict"
import test from "node:test"

import type { OpenCodeClient, ShellInfo } from "@opencode/client"

import { projectMissionActivity } from "./activity"
import { assertNativeMissionRecoveryReady } from "./native-recovery-observation"
import type { MissionActor, MissionMap, MissionSnapshot, MissionTask } from "./model"

const location = { directory: "/owned/repo" }

function actor(sessionId: string, kind: MissionActor["kind"] = "specialist"): MissionActor {
  return { sessionId, kind, managed: kind === "specialist", title: sessionId, roles: [kind], location, joinedAt: 1 }
}

function task(sessionId: string, report = false): MissionTask {
  return {
    id: `task-${sessionId}`, key: `task-${sessionId}`, title: "Task", brief: "Brief", role: "implementer",
    blockedBy: [], status: report ? "completed" : "queued", actorSessionId: sessionId, admissionId: `admission-${sessionId}`,
    createdAt: 1, updatedAt: 1, outstandingExecution: false,
    ...(report ? { report: { id: "report", taskKey: `task-${sessionId}`, sessionId, outcome: "completed" as const,
      summary: "Done", evidence: [], next: [], notificationStatus: "admitted" as const, createdAt: 2 } } : {}),
  }
}

function snapshot(actors: MissionActor[], tasks: MissionTask[] = []): MissionSnapshot {
  const mission: MissionMap = {
    version: 1, id: "msn_1", projectID: "project-1", projectCanonical: "canonical", objective: "Objective",
    template: "custom", status: "active", coordinatorSessionId: actors.find(item => item.kind === "coordinator")?.sessionId ?? "coordinator",
    actors, tasks, reports: [], frontier: [], claims: [], createdAt: 1, updatedAt: 1, revision: 1,
    history: [], historyTruncated: false,
  }
  return { version: 1, projectID: "project-1", generatedAt: 1, missions: [mission], discardedEvents: 0 }
}

function native(options: {
  active?: Record<string, { type: "running" }>
  inbox?: Record<string, unknown[]>
  shells?: ShellInfo[]
  forms?: Array<{ sessionID: string }>
  permissions?: Array<{ sessionID: string }>
  sessions?: Record<string, { projectID?: string; directory?: string; workspaceID?: string; outcome?: "succeeded"; parentID?: string }>
  incompleteTree?: boolean
  fail?: "active" | "inbox" | "forms" | "children"
} = {}): OpenCodeClient {
  const responseLocation = { directory: location.directory }
  return {
    session: {
      active: async () => { if (options.fail === "active") throw new Error("active failed"); return options.active ?? {} },
      get: async ({ sessionID }: { sessionID: string }) => {
        const value = options.sessions?.[sessionID]
        if (value === undefined && options.sessions) throw { status: 404 }
        return { id: sessionID, projectID: value?.projectID ?? "project-1", location: { directory: value?.directory ?? location.directory, workspaceID: value?.workspaceID },
          parentID: value?.parentID, outcome: value?.outcome, time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
      },
      list: async ({ parentID }: { parentID: string }) => {
        if (options.fail === "children") throw new Error("children failed")
        return { data: Object.entries(options.sessions ?? {}).filter(([, session]) => session.parentID === parentID).map(([id, session]) => ({
          id, parentID: session.parentID, projectID: session.projectID ?? "project-1", location: { directory: session.directory ?? location.directory, workspaceID: session.workspaceID },
        })), cursor: { next: options.incompleteTree ? "more" : null } }
      },
      inbox: { list: async ({ sessionID }: { sessionID: string }) => {
        if (options.fail === "inbox") throw new Error("inbox failed")
        return options.inbox?.[sessionID] ?? []
      } },
    },
    shell: { list: async () => ({ location: responseLocation, data: options.shells ?? [] }) },
    form: { list: async () => {
      if (options.fail === "forms") throw new Error("forms failed")
      return { location: responseLocation, data: options.forms ?? [] }
    } },
    permission: { request: { list: async () => ({ location: responseLocation, data: options.permissions ?? [] }) } },
  } as unknown as OpenCodeClient
}

async function states(options: Parameters<typeof native>[0], actors: MissionActor[], tasks: MissionTask[] = [], owns = true) {
  const result = await projectMissionActivity({
    client: native(options), snapshot: snapshot(actors, tasks), workspaceID: "workspace-1", now: () => 42,
    ownsLocation: async () => owns,
  })
  assert.equal(result.generatedAt, 42)
  return Object.fromEntries(result.missions[0]!.actors.map(item => [item.sessionId, item.state]))
}

test("native active state wins over an old successful outcome", async () => {
  assert.deepEqual(await states({ active: { specialist: { type: "running" } }, sessions: { specialist: { outcome: "succeeded" } } },
    [actor("specialist")], [task("specialist")]), { specialist: "running" })
})

test("projects an associated running Shell while its actor session is idle", async () => {
  const shell: ShellInfo = { id: "shell", status: "running", command: "test", cwd: location.directory, shell: "sh", file: "out",
    metadata: { sessionID: "specialist" }, time: { started: 1 } }
  assert.deepEqual(await states({ shells: [shell], sessions: { specialist: {} } }, [actor("specialist")], [task("specialist")]),
    { specialist: "background" })
})

test("uncorrelated running Shells cannot establish idle in projection or recovery", async () => {
  for (const metadata of [undefined, null, {}, { sessionID: undefined }, { sessionID: null },
    { sessionID: 42 }, { sessionID: false }, { sessionID: "" }, { sessionID: " " }]) {
    const shell = { id: "shell", status: "running", command: "test", cwd: location.directory, shell: "sh", file: "out",
      ...(metadata === undefined ? {} : { metadata }), time: { started: 1 } } as unknown as ShellInfo
    const client = native({ shells: [shell], sessions: { specialist: { outcome: "succeeded" } } })
    let mutations = 0
    client.session.environment = async () => { mutations++; throw new Error("Unexpected mutation") }
    client.session.synthetic = async () => { mutations++; throw new Error("Unexpected mutation") }
    client.session.interrupt = async () => { mutations++; throw new Error("Unexpected mutation") }
    const result = await projectMissionActivity({ client, snapshot: snapshot([actor("specialist")], [task("specialist")]),
      workspaceID: "workspace-1", ownsLocation: async () => true })
    assert.equal(result.missions[0].actors[0].state, "unknown", JSON.stringify(metadata))
    await assert.rejects(assertNativeMissionRecoveryReady(client, await client.session.get({ sessionID: "specialist" }),
      new AbortController().signal), error => Boolean(error && typeof error === "object" && "code" in error && error.code === "recovery-busy"))
    assert.equal(mutations, 0)
  }
})

test("known unrelated or finished Shells do not obscure proven idle, while descendants retain background activity", async () => {
  const sessions = { specialist: {}, child: { parentID: "specialist" } }
  const actors = [actor("specialist")], tasks = [task("specialist")]
  for (const [status, metadata] of [["running", { sessionID: "unrelated" }], ["completed", {}], ["failed", {}]] as const) {
    const shell = { id: "shell", status, metadata } as unknown as ShellInfo
    assert.deepEqual(await states({ sessions, shells: [shell] }, actors, tasks), { specialist: "idle-without-report" })
    const client = native({ sessions, shells: [shell] })
    await assertNativeMissionRecoveryReady(client, await client.session.get({ sessionID: "specialist" }), new AbortController().signal)
  }
  const childShell: ShellInfo = { id: "shell", status: "running", metadata: { sessionID: "child" }, command: "test",
    cwd: location.directory, shell: "sh", file: "out", time: { started: 1 } }
  assert.deepEqual(await states({ sessions, shells: [childShell] },
    actors, tasks), { specialist: "background" })
})

test("unattributed Shells do not erase positive execution, wait or queued-input evidence", async () => {
  const shell: ShellInfo = { id: "shell", status: "running", metadata: {}, command: "test", cwd: location.directory,
    shell: "sh", file: "out", time: { started: 1 } }
  const base = { sessions: { specialist: {} }, shells: [shell] }
  const actors = [actor("specialist")], tasks = [task("specialist")]
  assert.deepEqual(await states({ ...base, active: { specialist: { type: "running" } } }, actors, tasks), { specialist: "running" })
  assert.deepEqual(await states({ ...base, forms: [{ sessionID: "global" }] }, actors, tasks), { specialist: "form" })
  assert.deepEqual(await states({ ...base, permissions: [{ sessionID: "specialist" }] }, actors, tasks), { specialist: "permission" })
  assert.deepEqual(await states({ ...base, inbox: { specialist: [{ id: "pending" }] } }, actors, tasks), { specialist: "queued" })
})

test("does not treat admitted report notification as coordinator consumption", async () => {
  assert.deepEqual(await states({ sessions: { coordinator: {} } }, [actor("coordinator", "coordinator")]), { coordinator: "unknown" })
})

test("projects pending Forms and permissions without changing plan state", async () => {
  const actors = [actor("form-owner"), actor("permission-owner")]
  const result = await states({ sessions: { "form-owner": {}, "permission-owner": {} }, forms: [{ sessionID: "form-owner" }],
    permissions: [{ sessionID: "permission-owner" }] }, actors, actors.map(item => task(item.sessionId)))
  assert.deepEqual(result, { "form-owner": "form", "permission-owner": "permission" })
})

test("idle roots project their bounded native descendants rather than declaring missing reports prematurely", async () => {
  const sessions = { specialist: {}, child: { parentID: "specialist" }, grandchild: { parentID: "child" } }
  const actors = [actor("specialist")], tasks = [task("specialist")]
  assert.deepEqual(await states({ sessions, active: { grandchild: { type: "running" } } }, actors, tasks), { specialist: "background" })
  assert.deepEqual(await states({ sessions, inbox: { child: [{ id: "pending" }] } }, actors, tasks), { specialist: "queued" })
  assert.deepEqual(await states({ sessions, forms: [{ sessionID: "grandchild" }] }, actors, tasks), { specialist: "form" })
  assert.deepEqual(await states({ sessions, permissions: [{ sessionID: "child" }] }, actors, tasks), { specialist: "permission" })
  assert.deepEqual(await states({ sessions, forms: [{ sessionID: "global" }] }, actors, tasks), { specialist: "form" })
  assert.deepEqual(await states({ sessions, permissions: [{ sessionID: "global" }] }, actors, tasks), { specialist: "permission" })
  for (const options of [
    { sessions, fail: "children" as const }, { sessions, incompleteTree: true },
    { sessions: { ...sessions, child: { parentID: "specialist", directory: "/moved" } } },
    { sessions: { ...sessions, child: { parentID: "specialist", projectID: "foreign" } } },
  ]) assert.deepEqual(await states(options, actors, tasks), { specialist: "unknown" })
})

test("moved actors never trigger inbox or descendant reads", async () => {
  const client = native({ sessions: { specialist: { directory: "/moved" } } })
  let inboxes = 0, trees = 0
  client.session.inbox.list = async () => { inboxes++; return [] }
  client.session.list = async () => { trees++; return { data: [], cursor: { next: null } } }
  const result = await projectMissionActivity({ client, snapshot: snapshot([actor("specialist")], [task("specialist")]),
    workspaceID: "workspace-1", ownsLocation: async () => true })
  assert.equal(result.missions[0].actors[0].state, "unknown")
  assert.equal(inboxes, 0)
  assert.equal(trees, 0)
})

test("uses unknown for partial reads and foreign or moved actors, and missing only for an authoritative 404", async () => {
  assert.deepEqual(await states({ fail: "forms", sessions: { specialist: {} } }, [actor("specialist")], [task("specialist")]),
    { specialist: "unknown" })
  assert.deepEqual(await states({ sessions: { specialist: { projectID: "foreign" } } }, [actor("specialist")], [task("specialist")]),
    { specialist: "unknown" })
  assert.deepEqual(await states({ sessions: { specialist: { directory: "/owned/other" } } }, [actor("specialist")], [task("specialist")]),
    { specialist: "unknown" })
  assert.deepEqual(await states({ sessions: {} }, [actor("specialist")], [task("specialist")]), { specialist: "missing" })
  assert.deepEqual(await states({ sessions: { specialist: {} } }, [actor("specialist")], [task("specialist")], false),
    { specialist: "unknown" })
})

test("distinguishes queued assignment and idle work lacking a report", async () => {
  assert.deepEqual(await states({ sessions: { specialist: {} }, inbox: { specialist: [{ id: "queued" }] } },
    [actor("specialist")], [task("specialist")]), { specialist: "queued" })
  assert.deepEqual(await states({ sessions: { specialist: {} } }, [actor("specialist")], [task("specialist")]),
    { specialist: "idle-without-report" })
})

test("deduplicates bounded native actor and location reads across missions", async () => {
  let gets = 0
  let inboxes = 0
  let locationReads = 0
  const client = native({ sessions: { specialist: {} } }) as OpenCodeClient & Record<string, unknown>
  const get = client.session.get
  const inbox = client.session.inbox.list
  const shellList = client.shell.list
  client.session.get = async (...args: Parameters<typeof get>) => { gets += 1; return get(...args) }
  client.session.inbox.list = async (...args: Parameters<typeof inbox>) => { inboxes += 1; return inbox(...args) }
  client.shell.list = async (...args: Parameters<typeof shellList>) => { locationReads += 1; return shellList(...args) }
  const first = snapshot([actor("specialist")], [task("specialist")])
  first.missions.push({ ...first.missions[0]!, id: "msn_2" })

  const result = await projectMissionActivity({ client, snapshot: first, workspaceID: "workspace-1", ownsLocation: async () => true })
  assert.equal(result.missions.length, 2)
  assert.equal(gets, 1)
  assert.equal(inboxes, 1)
  assert.equal(locationReads, 1)
})

const binding = { generation: 1, parentSessionID: "coordinator", toolCallID: "call-one", parentMessageID: "message-one" }
function nativeTask(): MissionTask {
  const value = task("specialist")
  delete value.admissionId
  value.nativeBinding = binding
  value.nativeExecution = { binding, ended: "returned" }
  return value
}

test("native-bound idle missing reports and descendant queues need no invented admission ID", async () => {
  const value = nativeTask(), before = structuredClone(value)
  const sessions = { specialist: {}, child: { parentID: "specialist" } }
  assert.deepEqual(await states({ sessions }, [actor("specialist")], [value]), { specialist: "idle-without-report" })
  assert.deepEqual(await states({ sessions, inbox: { child: [{ id: "native-pending" }] } }, [actor("specialist")], [value]), { specialist: "queued" })
  assert.equal(value.admissionId, undefined)
  assert.deepEqual(value, before)
})

test("active continuation with an old completed report projects actual native activity, not historical completion", async () => {
  const value = nativeTask()
  Object.assign(value, { status: "completed", report: task("specialist", true).report,
    nativeBinding: { ...binding, nativeReturned: true },
    nativeExecution: { binding: { ...binding, toolCallID: "call-two", parentMessageID: "message-two" } } })
  const sessions = { specialist: { outcome: "succeeded" as const }, child: { parentID: "specialist" } }
  assert.deepEqual(await states({ sessions, active: { specialist: { type: "running" } } }, [actor("specialist")], [value]), { specialist: "running" })
  assert.deepEqual(await states({ sessions, active: { child: { type: "running" } } }, [actor("specialist")], [value]), { specialist: "background" })
  assert.deepEqual(await states({ sessions }, [actor("specialist")], [value]), { specialist: "unknown" }, "unsettled recorded call cannot prove idle")
  assert.deepEqual(await states({ sessions, inbox: { specialist: [{ id: "pending-continuation" }] } }, [actor("specialist")], [value]), { specialist: "queued" })
})

test("native failed-call settlement does not infer withdrawn outstanding work from historical binding", async () => {
  const value = nativeTask()
  value.status = "withdrawn"
  value.nativeExecution = { binding: { ...binding, toolCallID: "call-two", parentMessageID: "message-two" }, ended: "error" }
  const sessions = { specialist: {} }, actors = [actor("specialist")]
  assert.deepEqual(await states({ sessions }, actors, [value]), { specialist: "unknown" })
  assert.equal(value.outstandingExecution, false)
  value.outstandingExecution = true
  assert.deepEqual(await states({ sessions }, actors, [value]), { specialist: "idle-without-report" })
  value.report = task("specialist", true).report
  assert.deepEqual(await states({ sessions }, actors, [value]), { specialist: "unknown" })
})

test("partial current native evidence cannot be projected as proven idle-without-report", async () => {
  const value = nativeTask()
  value.nativeBinding = { ...binding, nativeReturned: true }
  delete value.nativeExecution
  assert.deepEqual(await states({ sessions: { specialist: {} } }, [actor("specialist")], [value]), { specialist: "unknown" })
  value.nativeExecution = { binding: { ...binding, generation: 2 }, ended: "returned" }
  assert.deepEqual(await states({ sessions: { specialist: {} } }, [actor("specialist")], [value]), { specialist: "unknown" })
})

test("full-Location actor changes are rejected before reading inboxes or descendants", async () => {
  for (const [recorded, actual] of [[undefined, "foreign"], ["owned", undefined], ["owned", "foreign"]]) {
    const selected = actor("specialist")
    selected.location = { ...location, workspaceID: recorded }
    const client = native({ sessions: { specialist: { workspaceID: actual } } })
    let reads = 0
    client.session.inbox.list = async () => { reads++; return [] }
    client.session.list = async () => { reads++; return { data: [], cursor: {} } }
    const result = await projectMissionActivity({ client, snapshot: snapshot([selected], [nativeTask()]), workspaceID: "workspace-1", ownsLocation: async () => true })
    assert.equal(result.missions[0].actors[0].state, "unknown")
    assert.equal(reads, 0)
  }
})

test("same-directory foreign-workspace descendants fail projection and recovery closed", async () => {
  const sessions = { specialist: {}, child: { parentID: "specialist" }, grandchild: { parentID: "child", workspaceID: "foreign" } }
  assert.deepEqual(await states({ sessions }, [actor("specialist")], [nativeTask()]), { specialist: "unknown" })
  const client = native({ sessions })
  await assert.rejects(assertNativeMissionRecoveryReady(client, await client.session.get({ sessionID: "specialist" }), new AbortController().signal),
    error => Boolean(error && typeof error === "object" && "code" in error && error.code === "recovery-unknown"))
})

test("paused and stopped maps retain truthful activity without authorizing execution or recovery", async () => {
  for (const state of ["paused", "stopped"] as const) {
    const value = nativeTask(), map = snapshot([actor("specialist")], [value])
    map.missions[0].runState = state
    if (state === "stopped") { map.missions[0].status = "stopped"; value.status = "withdrawn"; value.outstandingExecution = true }
    const before = structuredClone(map)
    for (const active of [false, true]) {
      const result = await projectMissionActivity({ client: native({ sessions: { specialist: {} }, active: active ? { specialist: { type: "running" } } : {} }),
        snapshot: map, workspaceID: "workspace-1", ownsLocation: async () => true })
      assert.equal(result.missions[0].actors[0].state, active ? "running" : "idle-without-report")
    }
    assert.deepEqual(map, before)
  }
})

test("stale contract generations stay unknown while positive native activity remains visible", async () => {
  const value = nativeTask()
  value.contractGeneration = binding.generation + 1
  const sessions = { specialist: {} }, actors = [actor("specialist")]
  assert.deepEqual(await states({ sessions }, actors, [value]), { specialist: "unknown" })
  assert.deepEqual(await states({ sessions, active: { specialist: { type: "running" } } }, actors, [value]), { specialist: "running" })
})

test("observed families reuse existing catalog reads, deduplicate inboxes and retain actual hierarchy", async () => {
  const actors = [actor("coordinator", "coordinator"), actor("specialist")]
  const sessions = { coordinator: {}, middle: { parentID: "coordinator" }, specialist: { parentID: "middle" }, leaf: { parentID: "specialist" } }
  const client = native({ sessions })
  let gets = 0, lists = 0, inboxes = 0
  const get = client.session.get, list = client.session.list, inbox = client.session.inbox.list
  client.session.get = async (...args: Parameters<typeof get>) => { gets++; return get(...args) }
  client.session.list = async (...args: Parameters<typeof list>) => { lists++; return list(...args) }
  client.session.inbox.list = async (...args: Parameters<typeof inbox>) => { inboxes++; return inbox(...args) }
  const map = snapshot(actors), before = structuredClone(map)
  const result = await projectMissionActivity({ client, snapshot: map, workspaceID: "workspace-1", ownsLocation: async () => true,
    isCurrent: () => true, now: () => 42 })
  assert.equal(result.generatedAt, 42)
  assert.deepEqual(result.missions[0].family, { state: "observed", members: [
    { sessionId: "coordinator", actorSessionId: "coordinator", kind: "declared" },
    { sessionId: "middle", parentSessionId: "coordinator", actorSessionId: "coordinator", kind: "ordinary" },
    { sessionId: "specialist", parentSessionId: "middle", actorSessionId: "specialist", kind: "declared" },
    { sessionId: "leaf", parentSessionId: "specialist", actorSessionId: "specialist", kind: "ordinary" },
  ] })
  assert.equal(gets, 2)
  assert.equal(lists, 6, "no second family catalog to build display membership")
  assert.equal(inboxes, 4, "overlapping declared-actor families read each inbox once")
  assert.deepEqual(map, before)
})

test("an absent currentness callback never claims observed membership or changes legacy actor activity", async () => {
  const result = await projectMissionActivity({ client: native({ sessions: { specialist: {} } }),
    snapshot: snapshot([actor("specialist")], [task("specialist")]), workspaceID: "workspace-1", ownsLocation: async () => true })
  assert.deepEqual(result.missions[0].family, { state: "unknown", members: [] })
  assert.equal(result.missions[0].actors[0].state, "idle-without-report")
})

test("missing, moved, foreign or failed observations clear the whole mission membership", async () => {
  const base = { coordinator: {}, specialist: { parentID: "coordinator" }, child: { parentID: "specialist" } }
  const actors = [actor("coordinator", "coordinator"), actor("specialist")]
  for (const options of [
    { sessions: { coordinator: {} } },
    { sessions: { ...base, specialist: { parentID: "coordinator", directory: "/moved" } } },
    { sessions: { ...base, child: { parentID: "specialist", workspaceID: "foreign" } } },
    { sessions: base, fail: "active" as const }, { sessions: base, fail: "inbox" as const },
    { sessions: base, fail: "forms" as const }, { sessions: base, fail: "children" as const },
    { sessions: base, incompleteTree: true },
  ]) {
    const result = await projectMissionActivity({ client: native(options), snapshot: snapshot(actors), workspaceID: "workspace-1",
      ownsLocation: async () => true, isCurrent: () => true })
    assert.deepEqual(result.missions[0].family, { state: "unknown", members: [] })
  }
})

test("inconsistent parents across otherwise valid root reads invalidate both mission families", async () => {
  const client = native({ sessions: { left: {}, right: {} } })
  client.session.list = async ({ parentID } = {}) => ({ data: parentID === "left" || parentID === "right" ? [
    { id: "same-child", parentID, projectID: "project-1", location },
  ] : [], cursor: { next: null } }) as Awaited<ReturnType<typeof client.session.list>>
  const map = snapshot([actor("left")])
  map.missions.push({ ...snapshot([actor("right")]).missions[0], id: "other-mission" })
  const result = await projectMissionActivity({ client, snapshot: map, workspaceID: "workspace-1", ownsLocation: async () => true,
    isCurrent: () => true })
  assert.ok(result.missions.every(mission => mission.family?.state === "unknown" && mission.family.members.length === 0))
})

test("currentness rejection at entry performs no client or ownership reads", async () => {
  const client = native()
  let reads = 0
  client.session.get = async () => { reads++; throw new Error("Unexpected read") }
  const result = await projectMissionActivity({ client, snapshot: snapshot([actor("specialist")]), workspaceID: "workspace-1",
    ownsLocation: async () => { reads++; return true }, isCurrent: () => false })
  assert.equal(reads, 0)
  assert.deepEqual(result.missions[0].family, { state: "unknown", members: [] })
  assert.equal(result.missions[0].actors[0].state, "unknown")
})

test("connection/deletion fences after each awaited phase discard membership and positive actor state", async () => {
  for (const phase of ["get", "ownership", "children", "inbox", "active", "shell", "form", "permission"] as const) {
    let current = true
    const client = native({ sessions: { specialist: {} }, active: { specialist: { type: "running" } } })
    if (phase === "get") { const read = client.session.get; client.session.get = async (...args: Parameters<typeof read>) => { const value = await read(...args); current = false; return value } }
    if (phase === "children") { const read = client.session.list; client.session.list = async (...args: Parameters<typeof read>) => { const value = await read(...args); current = false; return value } }
    if (phase === "inbox") { const read = client.session.inbox.list; client.session.inbox.list = async (...args: Parameters<typeof read>) => { const value = await read(...args); current = false; return value } }
    if (phase === "active") { const read = client.session.active; client.session.active = async (...args: Parameters<typeof read>) => { const value = await read(...args); current = false; return value } }
    if (phase === "shell") { const read = client.shell.list; client.shell.list = async (...args: Parameters<typeof read>) => { const value = await read(...args); current = false; return value } }
    if (phase === "form") { const read = client.form.list; client.form.list = async (...args: Parameters<typeof read>) => { const value = await read(...args); current = false; return value } }
    if (phase === "permission") { const read = client.permission.request.list; client.permission.request.list = async (...args: Parameters<typeof read>) => { const value = await read(...args); current = false; return value } }
    const result = await projectMissionActivity({ client, snapshot: snapshot([actor("specialist")]), workspaceID: "workspace-1",
      ownsLocation: async () => { if (phase === "ownership") current = false; return true }, isCurrent: () => current })
    assert.deepEqual(result.missions[0].family, { state: "unknown", members: [] }, phase)
    assert.equal(result.missions[0].actors[0].state, "unknown", phase)
  }
})

test("a currentness failure during final projection generation fences the returned display", async () => {
  let current = true
  const result = await projectMissionActivity({ client: native({ sessions: { specialist: {} } }), snapshot: snapshot([actor("specialist")]),
    workspaceID: "workspace-1", ownsLocation: async () => true, isCurrent: () => current, now: () => { current = false; return 123 } })
  assert.equal(result.generatedAt, 123)
  assert.deepEqual(result.missions[0].family, { state: "unknown", members: [] })
  assert.equal(result.missions[0].actors[0].state, "unknown")
})

test("ordinary descendants do not consume actor capacity or create authority/report metadata", async () => {
  const sessions: NonNullable<Parameters<typeof native>[0]>["sessions"] = { specialist: {} }
  for (let i = 0; i < 32; i++) sessions![`child-${i}`] = { parentID: "specialist" }
  const map = snapshot([actor("specialist")]), before = structuredClone(map)
  const result = await projectMissionActivity({ client: native({ sessions }), snapshot: map, workspaceID: "workspace-1",
    ownsLocation: async () => true, isCurrent: () => true })
  assert.equal(result.missions[0].family?.state, "observed")
  assert.equal(result.missions[0].family?.members.length, 33)
  assert.equal(result.missions[0].actors.length, 1)
  assert.deepEqual(map, before)
  assert.ok(result.missions[0].family?.members.every(member => Object.keys(member).every(key =>
    ["sessionId", "parentSessionId", "actorSessionId", "taskKey", "kind"].includes(key))))
})

test("fake native reads stay at fixed concurrency across roots and inboxes", async () => {
  const sessions: NonNullable<Parameters<typeof native>[0]>["sessions"] = {}
  const actors = Array.from({ length: 8 }, (_, i) => actor(`root-${i}`))
  for (const value of actors) {
    sessions![value.sessionId] = {}
    for (let i = 0; i < 4; i++) sessions![`${value.sessionId}-child-${i}`] = { parentID: value.sessionId }
  }
  const client = native({ sessions })
  let pending = 0, peak = 0
  const track = <Args extends unknown[], Result>(read: (...args: Args) => Promise<Result>) => async (...args: Args) => {
    pending++; peak = Math.max(peak, pending)
    try { await Promise.resolve(); return await read(...args) } finally { pending-- }
  }
  client.session.get = track(client.session.get)
  client.session.list = track(client.session.list)
  client.session.inbox.list = track(client.session.inbox.list)
  client.session.active = track(client.session.active)
  client.shell.list = track(client.shell.list)
  client.form.list = track(client.form.list)
  client.permission.request.list = track(client.permission.request.list)
  const result = await projectMissionActivity({ client, snapshot: snapshot(actors), workspaceID: "workspace-1",
    ownsLocation: async () => true, isCurrent: () => true })
  assert.equal(result.missions[0].family?.state, "observed")
  assert.equal(result.missions[0].family?.members.length, 40)
  assert.ok(peak > 1 && peak <= 4, `peak ${peak}`)
  assert.equal(pending, 0)
})

test("oversized snapshot input fails closed before unbounded native fan-out", async () => {
  const client = native()
  let reads = 0
  client.session.get = async () => { reads++; throw new Error("Unexpected read") }
  const map = snapshot(Array.from({ length: 9 }, (_, i) => actor(`root-${i}`)))
  const result = await projectMissionActivity({ client, snapshot: map, workspaceID: "workspace-1", ownsLocation: async () => true,
    isCurrent: () => true })
  assert.equal(reads, 0)
  assert.deepEqual(result.missions[0].family, { state: "unknown", members: [] })
})

test("a shared declared-root observation cannot contradict another mission's ordinary descendant", async () => {
  for (const missing of [false, true]) {
    const client = native({ sessions: { owner: {}, other: { parentID: "owner", workspaceID: "moved" } } })
    const get = client.session.get
    client.session.get = async (...args: Parameters<typeof get>) => {
      if (missing && args[0].sessionID === "other") throw { status: 404 }
      return get(...args)
    }
    client.session.list = async ({ parentID } = {}) => ({ data: parentID === "owner"
      ? [{ id: "other", parentID: "owner", projectID: "project-1", location }] : [], cursor: { next: null } }) as Awaited<ReturnType<typeof client.session.list>>
    const map = snapshot([actor("owner")])
    map.missions.push({ ...snapshot([actor("other")]).missions[0], id: "other-mission" })
    const result = await projectMissionActivity({ client, snapshot: map, workspaceID: "workspace-1",
      ownsLocation: async () => true, isCurrent: () => true })
    assert.ok(result.missions.every(mission => mission.family?.state === "unknown" && mission.family.members.length === 0))
  }
})

test("cross-mission native parent edges cannot fill holes in complete catalogs or form hidden cycles", async () => {
  for (const cycle of [false, true]) {
    const client = native({ sessions: { left: { ...(cycle ? { parentID: "right" } : {}) }, right: { parentID: "left" } } })
    client.session.list = async () => ({ data: [], cursor: { next: null } })
    const map = snapshot([actor("left")])
    map.missions.push({ ...snapshot([actor("right")]).missions[0], id: "other-mission" })
    const result = await projectMissionActivity({ client, snapshot: map, workspaceID: "workspace-1",
      ownsLocation: async () => true, isCurrent: () => true })
    assert.deepEqual(result.missions[0].family, { state: "unknown", members: [] })
    assert.deepEqual(result.missions[1].family, { state: "unknown", members: [] })
  }
})
