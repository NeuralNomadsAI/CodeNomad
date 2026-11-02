import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { currentPassageFixture } from "../../../server/src/opencode/missions/native-current-passage-test-fixture"
import { contentDigest } from "../../../server/src/missions/content-digest"
import { serverApi } from "../../src/lib/api-client"
import { createMissionContentStore, type MissionBodyRef } from "../../src/stores/mission-content-store"
import { TASK_READ_TIMEOUT_MS } from "../../src/lib/mission-task-read-lifetime"

const ref: MissionBodyRef = { instanceId: "fixture", projectID: "project", missionID: "msn_current", selector: { kind: "task", taskKey: "work", field: "brief" },
  passage: { owner: "daily", projectID: "project", scheduleID: "schedule", passageID: "passage", missionID: "msn_current", digest: "a".repeat(43) } }
const text = "0123456789", digest = contentDigest(text)
const slice = (offset: number) => ({ available: true as const, version: 1 as const, projectID: ref.projectID, missionID: ref.missionID, revision: 1,
  content: { ...ref.selector, digest, offset, characters: text.length, text: text.slice(offset, offset + 5), ...(offset === 0 ? { next: 5 } : {}) } })
const flush = async () => { for (let tick = 0; tick < 30; tick++) await Promise.resolve() }

for (const owner of ["daily", "scheduled"] as const) test(`${owner} a real escaped body cannot succeed after its original 30-second semantic demand deadline`, { timeout: 60_000 }, async t => {
  const f = await currentPassageFixture(owner), original = globalThis.fetch, brief = "\u0001".repeat(20_000)
  let handle: ReturnType<ReturnType<typeof createMissionContentStore>["use"]> | undefined
  try {
    let map = (await f.control.snapshot()).missions[0]
    map = (await f.control.revise(map.coordinatorSessionId, { missionID: map.id, requestID: "body-deadline", expectedRevision: map.revision,
      reason: "Escaped body", retireTasks: [], dependencyUpdates: [], addTasks: [{ taskKey: "deadline", title: "Deadline", brief,
        role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }] })).mission
    const source = (await f.read()).source!, started = performance.now(), times: Array<{ offset: number; at: number }> = [], offsets = new Set<number>()
    const operations: Array<{ signal: AbortSignal; deadline?: number }> = []
    let slow = true
    globalThis.fetch = async (_url, init) => {
      const input = JSON.parse(init!.body as string)
      assert.deepEqual(input.source, source)
      if (slow && !offsets.has(input.body.offset)) {
        offsets.add(input.body.offset); times.push({ offset: input.body.offset, at: performance.now() - started })
        await delay(16_000) // Each semantic slice fits alone; their total exceeds the real original budget.
      }
      init!.signal!.throwIfAborted()
      const value = await f.page(input)
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 65_536)
      return new Response(JSON.stringify(value))
    }
    const store = createMissionContentStore((body, query, signal, deadline) => {
      operations.push({ signal, deadline })
      return serverApi.fetchMissionCurrentBody(body.instanceId, source, { missionID: source.missionID, ...body.selector, ...query }, signal, deadline)
    })
    handle = store.use({ instanceId: "fixture", projectID: source.projectID, missionID: source.missionID, passage: source,
      selector: { kind: "task", taskKey: "deadline", field: "brief" } }, "real-source")
    handle.expect({ digest: contentDigest(brief), characters: brief.length }, map.revision); handle.need(Infinity)
    await delay(30_500)
    const atDeadline = handle.state().status
    await delay(3_000)
    const state = handle.state()
    t.diagnostic(JSON.stringify({ owner, elapsed: performance.now() - started, atDeadline, status: state.status, characters: state.body?.text.length, times }))
    assert.equal(offsets.size, 2, "the producer requires two automatic semantic offsets")
    assert.equal(state.status, "error", "automatic semantic slices must not publish success after the original 30 seconds")
    assert.equal(atDeadline, "error", "the logical demand is parked at the original deadline, before the late second answer")
    assert.ok((state.body?.text.length ?? 0) < brief.length)
    assert.equal(operations[0].signal, operations[1].signal)
    assert.equal(operations[0].deadline, operations[1].deadline)
    assert.ok(operations[0].deadline! <= started + TASK_READ_TIMEOUT_MS + 100)
    slow = false
    handle.retry()
    for (let tick = 0; handle.state().body?.text !== brief && tick < 100; tick++) await delay(10)
    assert.equal(handle.state().status, "ready"); assert.equal(handle.state().body?.text, brief)
    assert.ok(operations[2].deadline! > operations[0].deadline!)
    assert.notEqual(operations[2].signal, operations[0].signal)
  } finally { handle?.release(); globalThis.fetch = original; await f.dispose() }
})

for (const mode of ["continuation", "restart", "invalidation"] as const) test(`current automatic ${mode} retains its logical deadline and last-good display`, async t => {
  let clock = 0
  t.mock.method(performance, "now", () => clock)
  const calls: Array<{ offset: number; deadline?: number; signal: AbortSignal }> = []
  let store: ReturnType<typeof createMissionContentStore>
  store = createMissionContentStore(async (_ref, query, signal, deadline) => {
    calls.push({ offset: query.offset, signal, deadline })
    clock += mode === "restart" ? 11_000 : 16_000
    if (mode === "invalidation" && calls.length === 2) store.invalidate()
    if (mode === "restart" && calls.length === 2) return { available: true, version: 1, projectID: ref.projectID, missionID: ref.missionID, revision: 1, refused: "content-changed" }
    return slice(query.offset)
  })
  const handle = store.use(ref, "connection"); handle.need(Infinity)
  try {
    await flush()
    assert.equal(calls.length, mode === "restart" ? 3 : 2)
    assert.equal(handle.state().status, "error")
    assert.equal(handle.state().body?.text, text.slice(0, 5), "the last good prefix survives timeout")
    assert.ok(calls.every(call => call.deadline === TASK_READ_TIMEOUT_MS && call.signal === calls[0].signal))
    store.invalidate(); handle.version("new-metadata"); handle.expect({ digest, characters: text.length }, 2)
    await flush()
    assert.equal(calls.length, mode === "restart" ? 3 : 2, "automatic revalidation cannot allocate a fresh expired operation")
    assert.equal(handle.state().status, "error")
  } finally { handle.release() }
})

test("a later user demand gets a new budget; overlapping consumers share and cancel only their own logical operation", async t => {
  let clock = 0
  t.mock.method(performance, "now", () => clock)
  const calls: Array<{ deadline?: number; signal: AbortSignal }> = []
  const store = createMissionContentStore(async (_ref, query, signal, deadline) => {
    calls.push({ signal, deadline }); clock += 16_000; return slice(query.offset)
  })
  const first = store.use(ref, "connection")
  try {
    await flush(); assert.equal(first.state().body?.text, "01234")
    clock = 45_000; first.need(Infinity); await flush()
    assert.equal(first.state().body?.text, text); assert.equal(first.state().status, "ready")
    assert.equal(calls[0].deadline, 30_000); assert.equal(calls[1].deadline, 75_000)
    assert.notEqual(calls[0].signal, calls[1].signal)
  } finally { first.release() }
  let signal!: AbortSignal
  const held = createMissionContentStore(async (_ref, _query, live) => { signal = live; return new Promise(() => {}) })
  const a = held.use(ref, "connection"), b = held.use(ref, "connection")
  a.release(); assert.equal(signal.aborted, false)
  b.release(); assert.equal(signal.aborted, true)
  await flush()
})

test("current content validation crossing the deadline cannot promote even its first prefix", async t => {
  let clock = 0
  t.mock.method(performance, "now", () => clock)
  const store = createMissionContentStore(async () => {
    const result = slice(0)
    Object.defineProperty(result.content, "text", { get() { clock = 31_000; return "01234" } })
    return result
  })
  const handle = store.use(ref, "connection")
  try { await flush(); assert.equal(handle.state().status, "error"); assert.equal(handle.state().body, undefined) }
  finally { handle.release() }
})

test("a user extension of a parked current demand admits a fresh operation", async t => {
  let clock = 0, slow = true
  t.mock.method(performance, "now", () => clock)
  const deadlines: Array<number | undefined> = []
  const store = createMissionContentStore(async (_ref, query, _signal, deadline) => {
    deadlines.push(deadline); clock += slow ? 16_000 : 1_000; return slice(query.offset)
  })
  const handle = store.use(ref, "connection"); handle.need(6)
  try {
    await flush(); assert.equal(handle.state().status, "error"); assert.equal(handle.state().body?.text, "01234")
    clock = 45_000; slow = false; handle.need(10); await flush()
    assert.equal(handle.state().status, "ready"); assert.equal(handle.state().body?.text, text)
    assert.deepEqual(deadlines, [30_000, 30_000, 75_000])
  } finally { handle.release() }
})

for (const owner of ["daily", "scheduled"] as const) for (const trigger of ["reduce", "release"] as const)
  for (const late of ["success", "failure"] as const) test(`${owner} demand contraction by ${trigger} fences late ${late} and admits a later extension`, async t => {
    let clock = 0, resolve!: (value: ReturnType<typeof slice>) => void, reject!: (error: Error) => void
    t.mock.method(performance, "now", () => clock)
    const calls: Array<{ signal: AbortSignal; deadline?: number }> = []
    const store = createMissionContentStore(async (_ref, query, signal, deadline) => {
      calls.push({ signal, deadline })
      if (calls.length === 2) return new Promise((yes, no) => { resolve = yes; reject = no })
      return slice(query.offset)
    })
    const source = { ...ref, passage: { ...ref.passage!, owner } }
    const whole = store.use(source, "connection"), prefix = store.use(source, "connection")
    whole.need(Infinity); prefix.need(3)
    try {
      await flush(); assert.equal(calls.length, 2); assert.equal(prefix.state().body?.text, "01234")
      clock = 10_000
      if (trigger === "reduce") whole.need(3); else whole.release()
      assert.equal(calls[1].signal.aborted, true, "covered aggregate demand aborts immediately, not at the deadline")
      assert.equal(calls[1].signal.reason.name, "AbortError")
      clock = 31_000
      if (late === "success") resolve(slice(5)); else reject(new Error("Late unnecessary read failure"))
      await flush()
      assert.equal(prefix.state().status, "ready"); assert.equal(prefix.state().body?.text, "01234")
      assert.equal(calls.length, 2, "completion must not pump a replacement read")
      clock = 45_000; prefix.need(Infinity); await flush()
      assert.equal(prefix.state().status, "ready"); assert.equal(prefix.state().body?.text, text)
      assert.equal(calls[2].deadline, 75_000); assert.notEqual(calls[2].signal, calls[1].signal)
    } finally { whole.release(); prefix.release(); resolve?.(slice(5)) }
  })

for (const owner of ["daily", "scheduled"] as const) for (const trigger of ["reduce", "release"] as const)
  test(`${owner} ${trigger} preserves another consumer's outstanding lifetime`, async t => {
    let clock = 0, resolve!: (value: ReturnType<typeof slice>) => void
    t.mock.method(performance, "now", () => clock)
    const calls: Array<{ signal: AbortSignal; deadline?: number }> = []
    const store = createMissionContentStore(async (_ref, query, signal, deadline) => {
      calls.push({ signal, deadline })
      return query.offset === 0 ? slice(0) : new Promise(yes => { resolve = yes })
    })
    const source = { ...ref, passage: { ...ref.passage!, owner } }
    const a = store.use(source, "connection"), b = store.use(source, "connection")
    a.need(Infinity); b.need(10)
    try {
      await flush(); clock = 10_000
      if (trigger === "reduce") a.need(3); else a.release()
      assert.equal(calls[1].signal.aborted, false); assert.equal(calls[1].deadline, 30_000)
      clock = 29_000; resolve(slice(5)); await flush()
      assert.equal(b.state().status, "ready"); assert.equal(b.state().body?.text, text)
      assert.equal(calls.length, 2); assert.equal(calls[0].signal, calls[1].signal)
    } finally { a.release(); b.release(); resolve?.(slice(5)) }
  })

for (const owner of ["daily", "scheduled"] as const) for (const change of ["invalidate", "descriptor", "same-revision-descriptor"] as const)
  test(`${owner} contraction must retain ${change} revalidation despite an old covered prefix`, async t => {
    let clock = 0, resolve!: (value: ReturnType<typeof slice>) => void
    t.mock.method(performance, "now", () => clock)
    const calls: Array<{ signal: AbortSignal; deadline?: number }> = []
    const store = createMissionContentStore(async (_ref, query, signal, deadline) => {
      calls.push({ signal, deadline })
      return query.offset === 0 ? slice(0) : new Promise(yes => { resolve = yes })
    })
    const source = { ...ref, passage: { ...ref.passage!, owner } }
    const whole = store.use(source, "connection"), prefix = store.use(source, "connection")
    whole.need(Infinity); prefix.need(3)
    try {
      await flush(); clock = 10_000
      if (change === "invalidate") store.invalidate()
      else prefix.expect({ digest: contentDigest("new-value!"), characters: 10 }, change === "descriptor" ? 2 : 1)
      whole.release()
      assert.equal(calls[1].signal.aborted, false, "old coverage cannot complete fresh authority/descriptor revalidation")
      clock = 31_000; resolve(slice(5)); await flush()
      assert.equal(prefix.state().status, "error"); assert.equal(prefix.state().body?.text, "01234")
      assert.equal(calls.length, 2); assert.ok(calls.every(call => call.deadline === 30_000))
    } finally { whole.release(); prefix.release(); resolve?.(slice(5)) }
  })
