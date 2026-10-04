import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import type { MissionMap } from "../../missions/model"
import { assignmentInput, reportInput } from "../../missions/inputs"
import { missionRecoveryInput } from "../../missions/recovery-input"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { admitMissionInput } from "./mission-input"
import { registerAutomationPluginRoute } from "./automation-plugin"
import { AUTOMATION_BRIDGE_PATH } from "../../opencode/automation-plugin"
import { parseDelegateInput, parseInspectInput } from "../../opencode/missions-plugin"

function fixture() {
  const mission = {
    id: "msn_fixture", projectID: "project", objective: "Review", template: "custom", status: "active",
    coordinatorSessionId: "ses_coordinator", actors: [],
    tasks: [{ key: "review", title: "Review", brief: "Inspect", role: "reviewer", status: "dispatching", blockedBy: [],
      actorSessionId: "ses_actor", admissionId: "msg_assignment", delivery: "queue", execution: { agent: "review" } }],
  } as unknown as MissionMap
  const sessions = {
    ses_coordinator: { id: "ses_coordinator", projectID: "project", location: { directory: "/repo" } },
    ses_actor: { id: "ses_actor", projectID: "project", location: { directory: "/repo" }, agent: "review" },
  }
  mission.actors = Object.values(sessions).map(session => ({ sessionId: session.id, location: { ...session.location },
    kind: session.id === mission.coordinatorSessionId ? "coordinator" : "specialist", managed: false, title: "Actor", roles: [], joinedAt: 1 }))
  const state = { current: true, owned: true, variables: { TEMP: "first" }, failEnvironment: false,
    preparing: () => {}, onEnvironment: () => {} }
  const calls: Array<{ kind: string; input: any }> = []
  const gitContext: Array<{ kind: string; input: any }> = []
  const gitState = { onWrite: () => {} }
  const client = {
    rpc: () => ({ snapshot: async () => ({ projectID: "project", missions: [mission] }) }),
    session: {
      instructions: { entry: {
        put: async (input: unknown) => { gitContext.push({ kind: "put", input }); gitState.onWrite() },
        remove: async (input: unknown) => { gitContext.push({ kind: "remove", input }); gitState.onWrite() },
      } },
      get: async ({ sessionID }: { sessionID: keyof typeof sessions }) => structuredClone(sessions[sessionID]),
      environment: async (input: unknown) => {
        calls.push({ kind: "environment", input })
        state.onEnvironment()
        if (state.failEnvironment) throw new Error("SECRET native environment request")
      },
      prompt: async (input: unknown) => { calls.push({ kind: "prompt", input }) },
      synthetic: async (input: unknown) => { calls.push({ kind: "synthetic", input }) },
    },
  }
  const manager = {
    list: () => [{ id: "workspace" }],
    getSharedServiceClient: async () => client,
    getSharedServiceConnection: async () => ({ client, assertCurrent: () => { if (!state.current) throw new Error("stale") } }),
    ownsLocation: async () => state.owned,
    getWorktreeIdentityForPath: async () => "/repo",
    getSessionEnvironment: async () => { state.preparing(); return { ...state.variables } },
  }
  const fence = new WorktreeDeletionFence()
  const command = { kind: "prompt" as const, input: assignmentInput(mission, mission.tasks[0]) }
  const send = (input: unknown = command, signal = new AbortController().signal) =>
    admitMissionInput(manager as never, fence, "ses_coordinator", input, signal)
  return { mission, sessions, state, calls, manager, fence, command, send, gitContext, gitState }
}

test("mission inputs refresh profile environment on every admission, including synthetic reports", async () => {
  const f = fixture()
  f.manager.list = () => [{ id: "workspace" }, { id: "duplicate-tab" }]
  await f.send()
  f.state.variables = { TEMP: "changed" }
  await f.send()
  f.mission.tasks[0].report = { id: "rpt_1", sessionId: "ses_actor", taskKey: "review", outcome: "completed",
    summary: "Done", evidence: [], next: [], createdAt: 1 }
  await f.send({ kind: "synthetic", input: reportInput(f.mission, f.mission.tasks[0].report) })
  assert.deepEqual(f.calls.map(call => call.kind), ["environment", "prompt", "environment", "prompt", "environment", "synthetic"])
  assert.equal(f.calls[0].input.variables.TEMP, "first")
  assert.equal(f.calls[2].input.variables.TEMP, "changed")
  assert.equal(f.calls[4].input.sessionID, "ses_coordinator")
})

test("targeted recovery refuses native waits, then uses environment and one correlated synthetic", async () => {
  const f = fixture()
  f.mission.revision = 7
  f.mission.actors = Object.values(f.sessions).map(session => ({ sessionId: session.id, location: session.location, kind: "specialist", managed: false, title: "Actor", roles: [], joinedAt: 1 }))
  const client = (await f.manager.getSharedServiceConnection()).client as any
  let active = { ses_coordinator: { type: "running" } } as Record<string, unknown>
  client.session.active = async () => active
  client.session.list = async () => ({ data: [], cursor: { next: null } })
  client.session.inbox = { list: async () => [] }
  client.shell = { list: async () => ({ location: { directory: "/repo" }, data: [] }) }
  client.form = { list: async () => ({ location: { directory: "/repo" }, data: [] }) }
  client.permission = { request: { list: async () => ({ location: { directory: "/repo" }, data: [] }) } }
  const input = missionRecoveryInput(f.mission, { missionID: f.mission.id, expectedRevision: 7, target: "coordinator" })
  const command = { kind: "synthetic", input }
  await assert.rejects(f.send(command), /native work/)
  assert.equal(f.calls.length, 0)
  active = {}
  await f.send(command)
  assert.deepEqual(f.calls.map(call => call.kind), ["environment", "synthetic"])
  assert.equal(f.calls[1].input.id, input.id)
  f.calls.length = 0
  f.state.onEnvironment = () => { active = { ses_coordinator: { type: "running" } } }
  await assert.rejects(f.send(command), /native work/)
  assert.deepEqual(f.calls.map(call => call.kind), ["environment"], "a native wait appearing during preparation blocks the nudge")
})

test("targeted recovery fences saved-location mismatch and moves during every preparation stage", async () => {
  for (const stage of ["before", "environment", "readiness", "final-readiness", "git"] as const) {
    for (const sessionID of ["ses_actor", "ses_coordinator"] as const) {
      const f = fixture()
      f.mission.revision = 7
      const client = (await f.manager.getSharedServiceConnection()).client as any
      client.session.active = async () => ({})
      client.session.list = async () => ({ data: [], cursor: { next: null } })
      client.session.inbox = { list: async () => [] }
      client.shell = { list: async () => ({ location: { directory: "/repo" }, data: [] }) }
      client.form = { list: async () => ({ location: { directory: "/repo" }, data: [] }) }
      client.permission = { request: { list: async () => ({ location: { directory: "/repo" }, data: [] }) } }
      const input = missionRecoveryInput(f.mission, { missionID: f.mission.id, expectedRevision: 7, target: "report", taskKey: "review" })
      const move = () => { f.sessions[sessionID].location = { directory: "/foreign" } }
      if (stage === "before") move()
      if (stage === "environment") f.state.onEnvironment = move
      if (stage === "git") f.gitState.onWrite = move
      if (stage === "readiness") client.session.active = async () => { move(); return {} }
      if (stage === "final-readiness") {
        let observations = 0
        client.session.active = async () => { if (++observations === 2) move(); return {} }
      }
      await assert.rejects(f.send({ kind: "synthetic", input }), /admitted location|changed during admission/, `${stage}: ${sessionID}`)
      assert.equal(f.calls.some(call => call.kind === "synthetic"), false)
      assert.equal(f.calls.filter(call => call.kind === "environment").length, ["environment", "final-readiness", "git"].includes(stage) ? 1 : 0)
    }
  }
})

test("mission assignments and reports refresh degraded Git context and clear it on recovery", async () => {
  const f = fixture()
  const originalPath = process.env.PATH
  try {
    process.env.PATH = ""
    await f.send()
    assert.equal(f.gitContext[0].kind, "put")
    assert.equal(f.gitContext[0].input.sessionID, "ses_actor")
    assert.equal(f.gitContext[0].input.key, "codenomad.git-availability")
    assert.equal(f.gitContext[0].input.value.gitAvailable, false)
    f.mission.tasks[0].report = { id: "rpt_git", sessionId: "ses_actor", taskKey: "review", outcome: "completed",
      summary: "Done", evidence: [], next: [], createdAt: 1 }
    await f.send({ kind: "synthetic", input: reportInput(f.mission, f.mission.tasks[0].report) })
    assert.equal(f.gitContext[1].kind, "put")
    assert.equal(f.gitContext[1].input.sessionID, "ses_coordinator")
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
  await f.send()
  assert.equal(f.gitContext[2].kind, "remove")
  assert.deepEqual(f.gitContext[2].input, { sessionID: "ses_actor", key: "codenomad.git-availability" })
})

test("Git context failures stay advisory while cancellation and retirement still fence mission sends", async () => {
  for (const mode of ["advisory", "abort", "stale"] as const) {
    const f = fixture()
    const abort = new AbortController()
    f.gitState.onWrite = () => {
      if (mode === "abort") abort.abort()
      if (mode === "stale") f.state.current = false
      throw new Error("SECRET instruction failure")
    }
    if (mode === "advisory") {
      await f.send(f.command, abort.signal)
      assert.deepEqual(f.calls.map(call => call.kind), ["environment", "prompt"])
    } else {
      await assert.rejects(f.send(f.command, abort.signal))
      assert.deepEqual(f.calls.map(call => call.kind), ["environment"])
    }
    assert.equal(f.gitContext.length, 1)
    await f.fence.run("repo", ["/repo"], async () => {})
  }
})

test("the authenticated bridge admits maximum contracts after XML and JSON escaping", async () => {
  for (const template of ["custom", "pocock-fix-bug", "wayfinder"] as const) {
    for (const character of ["&", "\u0000", "界"]) {
      const f = fixture()
      const start = parseInspectInput({ start: { objective: character.repeat(20_000), template } }).start!
      const task = parseDelegateInput({ taskKey: "review", title: character.repeat(240),
        brief: character.repeat(20_000), role: "validator",
        blockedBy: Array.from({ length: 24 }, (_, index) => `${index}`.padEnd(64, "a")) })
      Object.assign(f.mission, start)
      Object.assign(f.mission.tasks[0], task)
      const command = { kind: "prompt", input: assignmentInput(f.mission, f.mission.tasks[0]) }
      const app = Fastify()
      registerAutomationPluginRoute(app, { workspaceManager: f.manager, worktreeDeletionFence: f.fence,
        authManager: { isLoopbackRequest: () => true }, bridgeToken: "fixture", nativeParent: {}, developerCdp: {} } as never)
      try {
        const response = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
          payload: { mode: "mission-input", sessionID: "ses_coordinator", command },
          headers: { "x-codenomad-automation-token": "fixture" } })
        assert.equal(response.statusCode, 200, `${template}: ${JSON.stringify(character)} ${response.body}`)
        assert.deepEqual(f.calls.map(call => call.kind), ["environment", "prompt"])
        assert.equal(f.calls[1].input.text, command.input.text)
      } finally { await app.close() }
    }
  }
})

test("admits a late report synthetic from a withdrawn task's durable late-report history", async () => {
  const f = fixture()
  const late = { id: "rpt_late", sessionId: "ses_actor", taskKey: "review", outcome: "completed" as const,
    summary: "Finished after retirement", evidence: [], next: [], late: true, createdAt: 2 }
  f.mission.tasks[0].status = "withdrawn"
  f.mission.tasks[0].lateReports = [late]
  await f.send({ kind: "synthetic", input: reportInput(f.mission, late) })
  assert.deepEqual(f.calls.map(call => call.kind), ["environment", "synthetic"])
  assert.equal(f.calls[1].input.id, reportInput(f.mission, late).id)
  assert.equal(f.calls[1].input.metadata["codenomad.mission"].reportID, late.id)
})

test("mission admission proceeds when an unrelated workspace connection is stalled", { timeout: 2_000 }, async t => {
  const f = fixture()
  let unblock!: () => void
  const stalled = new Promise<void>(resolve => { unblock = resolve })
  t.after(() => unblock())
  const connection = f.manager.getSharedServiceConnection
  f.manager.list = () => [{ id: "unrelated" }, { id: "workspace" }]
  const manager = { ...f.manager, getSharedServiceConnection: async (id: string) => {
    if (id === "unrelated") { await stalled; throw new Error("Unrelated connection unavailable") }
    return connection()
  } }
  await admitMissionInput(manager as never, f.fence, "ses_coordinator", f.command, new AbortController().signal)
  assert.deepEqual(f.calls.map(call => call.kind), ["environment", "prompt"])
})

test("rejects foreign ownership, changed selection, forged contracts and deletion before native writes", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.state.owned = false },
    (f: ReturnType<typeof fixture>) => { f.sessions.ses_actor.projectID = "foreign" },
    (f: ReturnType<typeof fixture>) => { f.sessions.ses_actor.agent = "other" },
    (f: ReturnType<typeof fixture>) => { f.command.input.text = "forged" },
    (f: ReturnType<typeof fixture>) => { f.mission.coordinatorSessionId = "ses_other" },
    (f: ReturnType<typeof fixture>) => { f.state.preparing = () => { f.sessions.ses_actor.location.directory = "/elsewhere" } },
    (f: ReturnType<typeof fixture>) => { f.state.preparing = () => { f.state.current = false } },
  ]) {
    const f = fixture()
    mutate(f)
    await assert.rejects(f.send())
    assert.equal(f.calls.length, 0)
  }
  const f = fixture()
  await f.fence.run("repo", ["/repo"], async () => {
    await assert.rejects(f.send(), /deletion/)
    assert.equal(f.calls.length, 0)
  })
  await f.send() // Refused admission did not leak the worktree fence.
})

test("environment errors, cancellation and connection retirement fail closed without prompt admission", async () => {
  for (const mode of ["environment", "stale", "abort"] as const) {
    const f = fixture()
    const abort = new AbortController()
    if (mode === "environment") f.state.failEnvironment = true
    f.state.onEnvironment = () => {
      if (mode === "stale") f.state.current = false
      if (mode === "abort") abort.abort()
    }
    await assert.rejects(f.send(f.command, abort.signal))
    assert.deepEqual(f.calls.map(call => call.kind), ["environment"])
    await f.fence.run("repo", ["/repo"], async () => {})
  }
})

test("desktop bridge authenticates mission dispatch and redacts native environment failures", async () => {
  const f = fixture()
  f.state.failEnvironment = true
  const app = Fastify()
  registerAutomationPluginRoute(app, { workspaceManager: f.manager, worktreeDeletionFence: f.fence,
    authManager: { isLoopbackRequest: () => true }, bridgeToken: "fixture", nativeParent: {}, developerCdp: {} } as never)
  try {
    const payload = { mode: "mission-input", sessionID: "ses_coordinator", command: f.command }
    assert.equal((await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH, payload })).statusCode, 401)
    const response = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH, payload,
      headers: { "x-codenomad-automation-token": "fixture" } })
    assert.equal(response.statusCode, 502)
    assert.doesNotMatch(response.body, /SECRET|TEMP|first/)
    assert.deepEqual(f.calls.map(call => call.kind), ["environment"])
  } finally { await app.close() }
})
