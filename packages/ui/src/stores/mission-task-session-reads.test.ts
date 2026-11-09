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
  const state = { connection: {} as object, generation: 1, first: [] as unknown[], coordinatorReads: 0, firstReads: 0, activeReads: 0, warnings: [] as unknown[] }
  let gate: ReturnType<typeof deferred<void>> | undefined
  const root = {
    message: {
      list: async (input: { sessionID: string }) => {
        if (input.sessionID === "ses_root") { state.coordinatorReads++; return { data: [], cursor: {} } }
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
  await store.demand("inst", mission, 1, "view")
  assert.equal(state.firstReads, 1)
  assert.equal(store.taskSession("inst", mission, "build"), undefined)
  // Same pulse: no new read.
  await store.demand("inst", mission, 1, "view")
  assert.equal(state.firstReads, 1)
  state.first = [{ type: "user", text: assignment("msn_one", "build") }]
  await store.demand("inst", mission, 2, "view")
  assert.equal(state.firstReads, 2)
  assert.equal(store.taskSession("inst", mission, "build"), "ses_child")
  assert.equal(store.sessionActive("inst", mission, "ses_child"), true)
  assert.equal(store.sessionIncludes("inst", mission, "ses_child"), true)
  assert.deepEqual(state.warnings, [])
})

test("an admitted non-assignment first message is examined once and never links", async () => {
  const { state, store } = harness()
  state.first = [{ type: "user", text: "Audit task build for mission msn_other; compare with mission msn_one." }]
  await store.demand("inst", mission, 1, "view")
  await store.demand("inst", mission, 2, "view")
  assert.equal(state.firstReads, 1)
  assert.equal(store.taskSession("inst", mission, "build"), undefined)
})

test("a task key arriving in a later directory window adopts cached canonical evidence without rereading the child", async () => {
  const { state, store } = harness()
  state.first = [{ type: "user", text: assignment("msn_one", "later") }]
  await store.demand("inst", mission, 1, "directory")
  assert.equal(store.taskSession("inst", mission, "later"), undefined)
  assert.equal(store.sessionIncludes("inst", mission, "ses_child"), false, "an undeclared key is only a cached candidate")
  const extended = { ...mission, tasks: [...mission.tasks, { key: "later", status: "ready" }] } as MissionMap
  await store.demand("inst", extended, 1, "directory")
  assert.equal(store.taskSession("inst", extended, "later"), "ses_child")
  assert.equal(store.sessionActive("inst", extended, "ses_child"), true)
  assert.equal(state.firstReads, 1)
})

test("directory and selected-tree owners retain monotonic key coverage at one revision and pulse", async () => {
  const { state, store } = harness()
  state.first = [{ type: "user", text: assignment("msn_one", "later") }]
  const directory = { ...mission, tasks: [...mission.tasks, { key: "later", status: "ready" }] } as MissionMap
  await store.demand("inst", mission, 1, "tree")
  await store.demand("inst", directory, 1, "directory")
  const before = { first: state.firstReads, active: state.activeReads }
  for (let attempt = 0; attempt < 10; attempt++) {
    await store.demand("inst", mission, 1, "tree")
    await store.demand("inst", directory, 1, "directory")
    assert.equal(store.taskSession("inst", directory, "later"), "ses_child")
  }
  assert.deepEqual({ first: state.firstReads, active: state.activeReads }, before, "owner windows do not trigger native rereads without a new pulse")
  assert.equal(state.firstReads, 1)
})

test("a retained older tree cannot downgrade newer directory evidence or queue an older continuation", async () => {
  const { state, store, hold } = harness()
  state.first = [{ type: "user", text: assignment("msn_one", "build") }]
  const newer = { ...mission, revision: mission.revision + 1 }
  const gate = hold(), pending = store.demand("inst", newer, 1, "directory")
  await new Promise(resolve => setImmediate(resolve))
  void store.demand("inst", mission, 2, "retained-tree")
  gate.resolve(); await pending
  await new Promise(resolve => setImmediate(resolve))
  for (let attempt = 0; attempt < 10; attempt++) {
    await store.demand("inst", mission, 2, "retained-tree")
    await store.demand("inst", newer, 1, "directory")
  }
  assert.equal(state.coordinatorReads, 1)
  assert.equal(state.firstReads, 1)
  assert.equal(state.activeReads, 1)
  assert.equal(store.taskSession("inst", newer, "build"), "ses_child")
})

test("an older demand cannot replace a newer queued directory revision", async () => {
  const { state, store, hold } = harness()
  state.first = [{ type: "user", text: assignment("msn_one", "later") }]
  const newer = { ...mission, revision: mission.revision + 1, tasks: [...mission.tasks, { key: "later", status: "ready" }] } as MissionMap
  const gate = hold(), pending = store.demand("inst", mission, 1, "tree")
  await new Promise(resolve => setImmediate(resolve))
  void store.demand("inst", newer, 2, "directory")
  void store.demand("inst", mission, 1, "tree")
  gate.resolve(); await pending
  await new Promise(resolve => setImmediate(resolve))
  await store.demand("inst", newer, 2, "directory")
  assert.equal(store.taskSession("inst", newer, "later"), "ses_child")
  assert.equal(state.coordinatorReads, 2, "one leading revision and its newest continuation")
  assert.equal(state.activeReads, 1)
})

test("a late child read after a connection or generation change publishes nothing", async () => {
  for (const change of ["connection", "generation"] as const) {
    const { state, store, hold } = harness()
    state.first = [{ type: "user", text: assignment("msn_one", "build") }]
    const gate = hold()
    const read = store.demand("inst", mission, 1, "view")
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
  const first = store.demand("inst", mission, 1, "view")
  await new Promise(resolve => setImmediate(resolve))
  void store.demand("inst", mission, 2, "view")
  void store.demand("inst", mission, 3, "view")
  state.first = [{ type: "user", text: assignment("msn_one", "build") }]
  gate.resolve()
  await first
  await new Promise(resolve => setImmediate(resolve))
  await store.demand("inst", mission, 3, "view")
  // One leading and one trailing read; the linked child is not reread.
  assert.equal(state.activeReads, 2)
  assert.equal(state.firstReads, 1)
  assert.equal(store.taskSession("inst", mission, "build"), "ses_child")
})

test("a different project keeps its own entry", async () => {
  const { state, store } = harness()
  state.first = [{ type: "user", text: assignment("msn_one", "build") }]
  await store.demand("inst", mission, 1, "view")
  assert.equal(store.taskSession("inst", { ...mission, projectID: "elsewhere" } as MissionMap, "build"), undefined)
})

test("activity invalidations without linked conversations never fan out an active-session read", async () => {
  const { state, store } = harness()
  const done = { ...mission, tasks: [{ key: "build", status: "completed" }] } as MissionMap
  await store.demand("inst", done, 1, "view")
  await store.demand("inst", done, 2, "view")
  assert.equal(state.firstReads, 0)
  assert.equal(state.activeReads, 0)
})

test("releasing the last owner stops a read in flight and drops its queued rerun; another owner keeps it", async () => {
  const { state, store, hold } = harness()
  state.first = [{ type: "user", text: assignment("msn_one", "build") }]
  // The only owner hides while the child read is held: nothing after it runs.
  let gate = hold()
  const read = store.demand("inst", mission, 1, "preview")
  for (let attempt = 0; state.firstReads === 0 && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 1))
  void store.demand("inst", mission, 2, "preview")
  store.release("inst", mission, "preview")
  gate.resolve(); await read
  assert.equal(state.activeReads, 0, "a released read stops before its next step")
  assert.equal(store.taskSession("inst", mission, "build"), undefined, "a released read publishes nothing")
  assert.equal(state.firstReads, 1, "its queued rerun is dropped")
  // With a second owner still showing the mission, releasing one keeps the read.
  gate = hold()
  const kept = store.demand("inst", mission, 3, "preview")
  void store.demand("inst", mission, 3, "selected")
  store.release("inst", mission, "preview")
  gate.resolve(); await kept
  assert.equal(store.taskSession("inst", mission, "build"), "ses_child")
  assert.equal(state.activeReads, 1)
})

test("a completed queued rerun registers no owner: releasing the last view still stops the next read", async () => {
  const { state, store, hold } = harness()
  const tick = () => new Promise(resolve => setImmediate(resolve))
  // A coalesced pulse runs as the trailing read of the same view.
  let gate = hold()
  const first = store.demand("inst", mission, 1, "preview")
  await tick()
  void store.demand("inst", mission, 2, "preview")
  gate.resolve(); await first
  for (let attempt = 0; state.firstReads < 2 && attempt < 50; attempt++) await tick()
  assert.equal(state.firstReads, 2, "the trailing read ran")
  await tick()
  // The next pulse's read is held; the view hides meanwhile.
  state.first = [{ type: "user", text: assignment("msn_one", "build") }]
  gate = hold()
  const next = store.demand("inst", mission, 3, "preview")
  for (let attempt = 0; state.firstReads < 3 && attempt < 50; attempt++) await tick()
  store.release("inst", mission, "preview")
  gate.resolve(); await next
  assert.equal(store.taskSession("inst", mission, "build"), undefined, "nothing is published without an owner")
  assert.equal(state.activeReads, 0)
})
