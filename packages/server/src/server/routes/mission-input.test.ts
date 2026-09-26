import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import type { MissionMap } from "../../missions/model"
import { assignmentInput, reportInput } from "../../missions/inputs"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { admitMissionInput } from "./mission-input"
import { registerAutomationPluginRoute } from "./automation-plugin"
import { AUTOMATION_BRIDGE_PATH } from "../../opencode/automation-plugin"

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
  const state = { current: true, owned: true, variables: { TEMP: "first" }, failEnvironment: false,
    preparing: () => {}, onEnvironment: () => {} }
  const calls: Array<{ kind: string; input: any }> = []
  const client = {
    rpc: () => ({ snapshot: async () => ({ projectID: "project", missions: [mission] }) }),
    session: {
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
  return { mission, sessions, state, calls, manager, fence, command, send }
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
