import assert from "node:assert/strict"
import test from "node:test"
import { createRoot } from "solid-js"
import { serverApi } from "../../src/lib/api-client"
import { backgroundReads } from "../../src/lib/background-read-queue"
import { createMissionContentStore } from "../../src/stores/mission-content-store"
import { createMissionPanelInventory } from "../../src/stores/mission-panel-inventory"
import { TASK_WINDOW_CHARACTERS } from "../../src/lib/mission-task-window-budget"
import { missionPanelPage } from "../../../server/src/missions/mission-panel-page"
import type { MissionCurrentSource } from "../../../server/src/missions/mission-current-source"
import { contentDigest } from "../../../server/src/missions/content-digest"

const source: MissionCurrentSource = { owner: "daily", projectID: "project", scheduleID: "schedule", passageID: "passage", missionID: "msn_current", digest: "a".repeat(43) }
const body = { missionID: source.missionID, kind: "task" as const, taskKey: "work", field: "brief", offset: 0 }
function reply(input: any, value: unknown, passage: unknown = source) {
  return new Response(JSON.stringify(missionPanelPage({ source: "mission", field: "body", missionID: source.missionID, projectID: source.projectID, revision: 1,
    discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false, passage: passage as MissionCurrentSource,
    window: { offset: 0, end: 1, total: 1, order: contentDigest(JSON.stringify(input.body)) } }, [value], input.selector.cursor)))
}

for (const poison of ["source", "length", "identity", "offset", "wire"] as const) test(`current body boundary refuses ${poison} before adopting or assembling content`, async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(init!.body as string)
    const value = { available: true, version: 1, projectID: source.projectID, missionID: source.missionID, revision: 1,
      content: { kind: "task", taskKey: "work", field: "brief", digest: "b".repeat(43), offset: poison === "offset" ? 1 : 0,
        characters: poison === "length" ? TASK_WINDOW_CHARACTERS + 1 : 1, text: "x", ...(poison === "length" ? { next: 1 } : {}) } }
    if (poison === "identity") value.missionID = "msn_foreign"
    if (poison === "wire") {
      const valid = await reply(input, value).text()
      return new Response(" ".repeat(65537 - new TextEncoder().encode(valid).length) + valid)
    }
    return reply(input, value, poison === "source" ? { ...source, passageID: "former" } : source)
  }
  try { await assert.rejects(serverApi.fetchMissionCurrentBody("fixture", source, body, new AbortController().signal)) }
  finally { globalThis.fetch = original; await backgroundReads.run(new AbortController().signal, async () => {}) }
})

test("current body selectors and source are copied before queued transport and escaped bytes remain exact", async () => {
  const original = globalThis.fetch, mutable = { ...source }, mutableBody = { ...body }, text = '"\\\n😀\ud800'.repeat(500)
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(init!.body as string)
    assert.deepEqual(input.source, source)
    assert.equal(input.body.taskKey, "work")
    return reply(input, { available: true, version: 1, projectID: source.projectID, missionID: source.missionID, revision: 2,
      content: { kind: "task", taskKey: "work", field: "brief", digest: contentDigest(text), offset: 0, characters: text.length, text } })
  }
  try {
    const pending = serverApi.fetchMissionCurrentBody("fixture", mutable, mutableBody, new AbortController().signal)
    mutable.passageID = "next-passage"
    mutableBody.taskKey = "changed"
    const answer = await pending
    assert.ok(answer.available && "content" in answer); assert.equal(answer.content.text, text)
  } finally { globalThis.fetch = original; await backgroundReads.run(new AbortController().signal, async () => {}) }
})

test("a pending passage body cannot publish a newer digest for an older row, and Retry pins the admitted descriptor", async () => {
  let release!: (value: any) => void, call = 0
  const requests: Array<{ digest?: string; offset: number }> = []
  const expected = contentDigest("old"), newer = contentDigest("new")
  const store = createMissionContentStore(async (_ref, query) => {
    requests.push(query); call++
    if (call === 1) return new Promise(resolve => { release = resolve })
    return { available: true, version: 1, projectID: "project", missionID: source.missionID, revision: 1,
      content: { kind: "task", taskKey: "work", field: "brief", digest: expected, offset: 0, characters: 3, text: "old" } }
  })
  await new Promise<void>((resolve, reject) => createRoot(dispose => {
    const handle = store.use({ instanceId: "fixture", projectID: "project", missionID: source.missionID, selector: { kind: "task", taskKey: "work", field: "brief" }, passage: source }, "connection")
    handle.expect({ digest: expected, characters: 3 }, 1)
    release({ available: true, version: 1, projectID: "project", missionID: source.missionID, revision: 2,
      content: { kind: "task", taskKey: "work", field: "brief", digest: newer, offset: 0, characters: 3, text: "new" } })
    void (async () => {
      try {
        for (let tick = 0; tick < 5; tick++) await Promise.resolve()
        assert.equal(handle.state().status, "error"); assert.equal(handle.state().body, undefined)
        handle.retry()
        for (let tick = 0; tick < 5; tick++) await Promise.resolve()
        assert.equal(handle.state().body?.text, "old"); assert.equal(requests[1].digest, expected)
        handle.release(); dispose(); resolve()
      } catch (error) { handle.release(); dispose(); reject(error) }
    })()
  }))
})

for (const poison of ["depth", "tokens"] as const) test(`current structured bodies enforce ${poison} budgets before whole-value parsing`, async () => {
  const text = poison === "depth" ? "[".repeat(30) + "0" + "]".repeat(30) : "[" + "0,".repeat(270000) + "0]"
  const store = createMissionContentStore(async () => ({ available: true, version: 1, projectID: "project", missionID: source.missionID, revision: 1,
    content: { kind: "task", taskKey: "work", field: "report", json: true, digest: contentDigest(text), offset: 0, characters: text.length, text } }))
  await new Promise<void>((resolve, reject) => createRoot(dispose => {
    const handle = store.use({ instanceId: "fixture", projectID: "project", missionID: source.missionID, selector: { kind: "task", taskKey: "work", field: "report" }, passage: source }, "connection")
    void (async () => {
      try {
        for (let tick = 0; tick < 5; tick++) await Promise.resolve()
        assert.equal(handle.state().status, "error"); assert.equal(handle.state().body, undefined)
        handle.release(); dispose(); resolve()
      } catch (error) { handle.release(); dispose(); reject(error) }
    })()
  }))
})

test("actual current transport retains two stream owners and releases cancelled/deadline cleanup without late dispatch", async t => {
  const original = globalThis.fetch, early = new AbortController(), deadline = performance.now() + 200
  let reject!: (error: Error) => void, live = 0, maxLive = 0, cancels = 0, released = false
  const held = new Promise<void>((_, rejectGate) => { reject = rejectGate })
  const starts: Array<{ at: number; aborted: boolean }> = []
  globalThis.fetch = async (_url, init) => {
    const signal = init!.signal!; starts.push({ at: performance.now(), aborted: signal.aborted })
    live++; maxLive = Math.max(maxLive, live)
    signal.addEventListener("abort", () => { live-- }, { once: true })
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)) }, cancel() { cancels++; return held } }))
  }
  const keepAlive = setTimeout(() => {}, 3000), cancel = setTimeout(() => early.abort(), 120)
  const calls = Array.from({ length: 3 }, (_, index) => serverApi.fetchMissionCurrentPanel("fixture", source, { source: "mission", missionID: source.missionID, header: true },
    { deadline, current: () => true, ...(index === 0 ? { signal: early.signal } : {}) }))
  let markerAt = 0, markerWhileHeld = false
  const marker = backgroundReads.run(AbortSignal.timeout(1500), async () => { markerAt = performance.now(); markerWhileHeld = !released })
  try {
    const results = await Promise.allSettled(calls); await marker
    assert.ok(results.every(result => result.status === "rejected"))
    assert.equal(maxLive, 2); assert.ok(starts.length >= 2 && starts.length <= 3); assert.equal(cancels, starts.length)
    assert.ok(starts.every(start => !start.aborted && start.at < deadline))
    assert.equal(markerWhileHeld, true); assert.ok(markerAt <= deadline + 1000)
    t.diagnostic(JSON.stringify({ starts, maxLive, cancels, deadline, markerAt, markerWhileHeld }))
  } finally {
    released = true; reject(new Error("Observed late current cancellation rejection")); clearTimeout(cancel); clearTimeout(keepAlive)
    await Promise.allSettled(calls); await marker; await backgroundReads.run(new AbortController().signal, async () => {})
    globalThis.fetch = original
  }
})

test("the final current-passage display owner aborts a held range while retaining its reader demand identity", async () => {
  let entered!: () => void, signal!: AbortSignal
  const started = new Promise<void>(resolve => { entered = resolve })
  const store = createMissionPanelInventory({ passage: source, scope: () => "/fixture", projectID: () => source.projectID,
    tasks: async () => { throw Error("No implicit task fallback") }, read: (_instance, _selector, scope) => {
      signal = scope.signal!; entered()
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    } })
  try {
    store.setDemand("fixture", true); store.want("fixture", "passage", source.missionID, true)
    await started; store.setDemand("fixture", false)
    assert.equal(signal.aborted, true, "a hidden passage has no live range observer even though its cached target remains selected")
  } finally { store.clear("fixture") }
})
