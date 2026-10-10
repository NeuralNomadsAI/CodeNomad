import assert from "node:assert/strict"
import { test } from "node:test"
import type { MissionMap } from "../../../server/src/api-types"
import { createMissionTaskSessions } from "./mission-task-session-reads"

const assignment = (mission: string, key: string) => `# CodeNomad Mission Assignment

You are a native task actor in mission ${mission}.

Playbook: Custom
Role: Implementer (implementer)
Task key: ${key}
Blocked by: none
`
const mission = {
  id: "msn_one", projectID: "project", coordinatorSessionId: "ses_root", revision: 4,
  tasks: [{ key: "build", status: "running" }],
} as unknown as MissionMap

function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve }
}

/** A native replay: coordinator has no completed call yet; its direct child is listed. */
function harness() {
  const state = { connection: {} as object, generation: 1, first: [] as unknown[], firstReads: 0, activeReads: 0, warnings: [] as unknown[] }
  let gate: ReturnType<typeof deferred<void>> | undefined
  const root = {
    message: {
      list: async (input: { sessionID: string }) => {
        if (input.sessionID === "ses_root") return { data: [], cursor: {} }
        state.firstReads += 1
        if (gate) await gate.promise
        return { data: state.first }
      },
    },
    session: {
      list: async () => ({ data: [{ id: "ses_child" }] }),
      active: async () => { state.activeReads += 1; return { ses_child: { type: "busy" } } },
    },
  }
  const store = createMissionTaskSessions({
    connection: () => state.connection,
    generation: () => state.generation,
    root: () => root as never,
    warn: (_message, details) => state.warnings.push(details),
  })
  return { state, store, hold: () => { gate = deferred(); return gate } }
}

test("a child read before its first message is admitted links on a later pulse of the same revision", async () => {
  const { state, store } = harness()
  await store.demand("inst", mission, 1)
  assert.equal(state.firstReads, 1)
  assert.equal(store.taskSession("inst", mission, "build"), undefined)
  // Same pulse: no new read.
  await store.demand("inst", mission, 1)
  assert.equal(state.firstReads, 1)
  state.first = [{ type: "user", text: assignment("msn_one", "build") }]
  await store.demand("inst", mission, 2)
  assert.equal(state.firstReads, 2)
  assert.equal(store.taskSession("inst", mission, "build"), "ses_child")
  assert.equal(store.sessionActive("inst", mission, "ses_child"), true)
  assert.equal(store.sessionIncludes("inst", mission, "ses_child"), true)
  assert.deepEqual(state.warnings, [])
})

test("an admitted non-assignment first message is examined once and never links", async () => {
  const { state, store } = harness()
  state.first = [{ type: "user", text: "Audit task build for mission msn_other; compare with mission msn_one." }]
  await store.demand("inst", mission, 1)
  await store.demand("inst", mission, 2)
  assert.equal(state.firstReads, 1)
  assert.equal(store.taskSession("inst", mission, "build"), undefined)
})

test("a late child read after a connection or generation change publishes nothing", async () => {
  for (const change of ["connection", "generation"] as const) {
    const { state, store, hold } = harness()
    state.first = [{ type: "user", text: assignment("msn_one", "build") }]
    const gate = hold()
    const read = store.demand("inst", mission, 1)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.firstReads, 1)
    if (change === "connection") state.connection = {}
    else state.generation += 1
    gate.resolve()
    await read
    assert.equal(store.taskSession("inst", mission, "build"), undefined, change)
    assert.equal(store.sessionActive("inst", mission, "ses_child"), false, change)
  }
})

test("demand during a read is coalesced into one trailing read", async () => {
  const { state, store, hold } = harness()
  const gate = hold()
  const first = store.demand("inst", mission, 1)
  await new Promise(resolve => setImmediate(resolve))
  void store.demand("inst", mission, 2)
  void store.demand("inst", mission, 3)
  state.first = [{ type: "user", text: assignment("msn_one", "build") }]
  gate.resolve()
  await first
  await new Promise(resolve => setImmediate(resolve))
  await store.demand("inst", mission, 3)
  // One leading and one trailing read; the linked child is not reread.
  assert.equal(state.activeReads, 2)
  assert.equal(state.firstReads, 1)
  assert.equal(store.taskSession("inst", mission, "build"), "ses_child")
})

test("a different project keeps its own entry", async () => {
  const { state, store } = harness()
  state.first = [{ type: "user", text: assignment("msn_one", "build") }]
  await store.demand("inst", mission, 1)
  assert.equal(store.taskSession("inst", { ...mission, projectID: "elsewhere" } as MissionMap, "build"), undefined)
})
