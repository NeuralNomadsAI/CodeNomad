import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { createComputed, createRoot } from "solid-js"
import { contentDigest } from "../../../server/src/missions/content-digest"
import { currentPassageFixture } from "../../../server/src/opencode/missions/native-current-passage-test-fixture"
import { serverApi } from "../../src/lib/api-client"
import { missionBodyNeed } from "../../src/lib/mission-body-pages"
import { createMissionContentStore, type MissionBodyConsumer, type MissionBodyRef } from "../../src/stores/mission-content-store"

const A = "aaaaaaaaaa", B = "bbbbbbbbbb", C = "cccccccccc"
const flush = async () => { for (let tick = 0; tick < 60; tick++) await Promise.resolve() }
function observe(handle: MissionBodyConsumer) {
  const digests: string[] = []
  const dispose = createRoot(dispose => { createComputed(() => { const digest = handle.state().body?.digest; if (digest) digests.push(digest) }); return dispose })
  return { digests, dispose }
}
async function pending(owner: "daily" | "scheduled", prefixNeed = 3) {
  let value = A, revision = 1, held = false, resolve!: (value: ReturnType<typeof answer>) => void, reject!: (error: Error) => void
  const ref: MissionBodyRef = { instanceId: "fixture", projectID: "project", missionID: "msn_pending", selector: { kind: "mission", field: "notes" },
    passage: { owner, projectID: "project", scheduleID: "schedule", passageID: "passage", missionID: "msn_pending", digest: "a".repeat(43) } }
  const answer = (offset: number, text = value, at = revision) => ({ available: true as const, version: 1 as const, projectID: ref.projectID,
    missionID: ref.missionID, revision: at, content: { ...ref.selector, digest: contentDigest(text), offset, characters: text.length,
      text: text.slice(offset, offset + 5), ...(offset === 0 ? { next: 5 } : {}) } })
  const calls: Array<{ offset: number; signal: AbortSignal; deadline?: number }> = []
  const store = createMissionContentStore(async (_ref, query, signal, deadline) => {
    calls.push({ offset: query.offset, signal, deadline })
    if (value === B && query.offset === 5 && !held) { held = true; return new Promise((yes, no) => { resolve = yes; reject = no }) }
    return answer(query.offset)
  })
  const whole = store.use(ref, "connection"), prefix = store.use(ref, "connection")
  whole.need(10); prefix.need(prefixNeed); await flush()
  assert.equal(prefix.state().body?.text, A)
  const seen = observe(prefix)
  value = B; revision = 2; whole.expect({ digest: contentDigest(B), characters: 10 }, 2); await flush()
  assert.ok(held); assert.equal(prefix.state().body?.text, A, "B must actually be pending before the provenance change")
  const heldCall = calls.at(-1)!, before = calls.length
  return { store, ref, whole, prefix, calls, heldCall, before, seen,
    current() { value = C; revision = 3 },
    settle(failure = false) { if (failure) reject(new Error("Late B failure")); else resolve(answer(5, B, 2)) },
    dispose() { whole.release(); prefix.release(); resolve(answer(5, B, 2)); seen.dispose() },
  }
}

// Keep the review's exact 20-case baseline: six old-code failures and fourteen controls.
for (const owner of ["daily", "scheduled"] as const) for (const change of ["descriptor", "same-revision", "invalidate", "expired", "valid"] as const)
  for (const trigger of ["reduce", "release"] as const) test(`${owner} pending baseline ${change}/${trigger}`, async t => {
    let clock = 0
    t.mock.method(performance, "now", () => clock)
    const f = await pending(owner)
    try {
      clock = change === "expired" ? 31_000 : 10_000
      if (change === "descriptor" || change === "same-revision") {
        f.current(); f.prefix.expect({ digest: contentDigest(C), characters: 10 }, change === "descriptor" ? 3 : 2)
      }
      if (change === "invalidate") { f.current(); f.store.invalidate() }
      if (trigger === "reduce") f.whole.need(3); else f.whole.release()
      assert.equal(f.prefix.state().body?.text, change === "valid" ? B.slice(0, 5) : A)
      assert.equal(f.calls.length, f.before, "contraction neither restarts nor renews an outstanding operation")
      assert.equal(f.heldCall.signal.aborted, change === "valid")
      if (change !== "valid") assert.ok(f.seen.digests.every(digest => digest === contentDigest(A)), "no transient B publication")
      f.settle(); await flush()
      if (change === "valid") {
        assert.equal(f.prefix.state().body?.text, B.slice(0, 5)); assert.equal(f.prefix.state().status, "ready")
        assert.equal(f.calls.length, f.before)
      } else {
        assert.equal(f.prefix.state().body?.text, A); assert.ok(!f.seen.digests.includes(contentDigest(B)))
        assert.ok(f.calls.slice(f.before).length <= 1, "at most the existing coalesced invalidation read")
        assert.ok(f.calls.slice(f.before).every(call => call.deadline === f.heldCall.deadline))
        if (change === "invalidate") f.prefix.expect({ digest: contentDigest(C), characters: 10 }, 3)
        clock += 1_000; f.prefix.retry(); await flush()
        const expected = change === "expired" ? B : C
        assert.equal(f.prefix.state().body?.text, expected.slice(0, 5)); assert.equal(f.prefix.state().status, "ready")
        assert.ok(f.calls.at(-1)!.deadline! > f.heldCall.deadline!)
      }
    } finally { f.dispose(); await flush() }
  })

for (const owner of ["daily", "scheduled"] as const) for (const change of ["descriptor", "same-revision", "invalidate", "mark"] as const)
  for (const late of ["success", "failure"] as const) test(`${owner} pending need increase and automatic accept/revalidation preserve ${change} after late ${late}`, async t => {
    let clock = 0
    t.mock.method(performance, "now", () => clock)
    const f = await pending(owner, 1)
    try {
      clock = 10_000; f.current()
      if (change === "descriptor" || change === "same-revision") f.prefix.expect({ digest: contentDigest(C), characters: 10 }, change === "descriptor" ? 3 : 2)
      else if (change === "invalidate") f.store.invalidate()
      else f.prefix.version("current-mark")
      f.whole.release(); f.prefix.need(4)
      assert.equal(f.prefix.state().body?.text, A); assert.ok(!f.seen.digests.includes(contentDigest(B)))
      assert.equal(f.calls.length, f.before); assert.equal(f.heldCall.signal.aborted, false)
      f.settle(late === "failure"); await flush()
      assert.equal(f.prefix.state().body?.text, A); assert.ok(!f.seen.digests.includes(contentDigest(B)), "automatic accept cannot publish old B")
      assert.ok(f.calls.length <= f.before + 1); assert.ok(f.calls.every(call => call.deadline === 30_000))
      if (change === "invalidate" || change === "mark") f.prefix.expect({ digest: contentDigest(C), characters: 10 }, 3)
      clock = 20_000; f.prefix.retry(); await flush()
      assert.equal(f.prefix.state().body?.text, C.slice(0, 5)); assert.equal(f.prefix.state().status, "ready")
      assert.equal(f.calls.at(-1)!.deadline, 50_000); assert.ok(!f.seen.digests.includes(contentDigest(B)))
    } finally { f.dispose(); await flush() }
  })

for (const owner of ["daily", "scheduled"] as const) test(`${owner} an ended operation cannot promote its cached pending value on new user demand`, async t => {
  let clock = 0
  t.mock.method(performance, "now", () => clock)
  const f = await pending(owner, 10)
  let reopened: MissionBodyConsumer | undefined
  try {
    f.whole.release(); f.prefix.release(); assert.equal(f.heldCall.signal.aborted, true)
    clock = 45_000; reopened = f.store.use(f.ref, "connection"); reopened.need(3)
    assert.equal(reopened.state().body?.text, A, "cached unpromoted B has no live validation operation")
    assert.equal(f.calls.length, f.before + 1, "new demand must actually read B under a fresh operation")
    assert.equal(f.calls.at(-1)!.deadline, 75_000); assert.notEqual(f.calls.at(-1)!.signal, f.heldCall.signal)
    f.settle(); await flush()
    assert.equal(reopened.state().body?.text, B.slice(0, 5), "the old held tail cannot extend the newly validated prefix")
    assert.equal(reopened.state().status, "ready")
  } finally { reopened?.release(); f.dispose(); await flush() }
})

async function waitFor(predicate: () => boolean, message: string) {
  const until = performance.now() + 5_000
  while (!predicate() && performance.now() < until) await delay(5)
  assert.ok(predicate(), message)
}
async function started(promise: Promise<void>) {
  const cancel = new AbortController()
  try { await Promise.race([promise, delay(5_000, undefined, { signal: cancel.signal }).then(() => { throw Error("Semantic continuation did not start") })]) }
  finally { cancel.abort() }
}

for (const owner of ["daily", "scheduled"] as const) for (const change of ["descriptor", "same-revision", "invalidate"] as const)
  for (const trigger of ["reduce", "release", "increase"] as const) test(`${owner} actual reader pending ${change}/${trigger} retains A until header-bound C`, { timeout: 20_000 }, async t => {
    const f = await currentPassageFixture(owner), original = globalThis.fetch
    let releaseA!: () => void, releaseB!: () => void, enterA!: () => void, enterB!: () => void
    const gateA = new Promise<void>(resolve => { releaseA = resolve }), gateB = new Promise<void>(resolve => { releaseB = resolve })
    const startedA = new Promise<void>(resolve => { enterA = resolve }), startedB = new Promise<void>(resolve => { enterB = resolve })
    let whole: MissionBodyConsumer | undefined, prefix: MissionBodyConsumer | undefined, seen: ReturnType<typeof observe> | undefined
    try {
      let map = (await f.control.snapshot()).missions[0]
      const make = (lead: string) => { const first = lead + "\n\n" + "\u0001".repeat(12_000) + "\n"; return first + "\u0001".repeat(20_000 - first.length) }
      const a = make("OLD_A"), b = make("LONGER_PENDING_B_MARKER_THAN_A"), c = "CURRENT_C\n".padEnd(20_000, "c")
      const da = contentDigest(a), db = contentDigest(b), dc = contentDigest(c)
      const update = async (notes: string, requestID: string) => { map = (await f.control.update({ missionID: map.id, requestID,
        expectedRevision: map.revision, objective: map.objective, notes })).mission }
      await update(a, "page-a")
      const source = (await f.read()).source!, operations: Array<{ deadline?: number; signal: AbortSignal }> = []
      const header = async () => {
        const result = await f.page({ source, selector: { source: "mission", missionID: map.id, header: true } })
        assert.ok(result.available && !result.page.next); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65_536)
        const value = JSON.parse(result.page.pieces.map(piece => piece.text).join("")); assert.equal(value.root.revision, map.revision)
        return value.root
      }
      let pendingOffset = 0
      globalThis.fetch = async (_url, init) => {
        const input = JSON.parse(init!.body as string); assert.deepEqual(input.source, source)
        if (input.body.offset > 0 && input.body.digest === da) { enterA(); await gateA; init!.signal!.throwIfAborted() }
        if (input.body.offset > 0 && input.body.digest === db) {
          const captured = await f.page(input) // A legal B observation, held before the C edit.
          pendingOffset = input.body.offset; enterB(); await gateB
          return new Response(JSON.stringify(captured)) // Deliberately late, even if its owner has cancelled.
        }
        const value = await f.page(input); assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 65_536)
        return new Response(JSON.stringify(value))
      }
      const store = createMissionContentStore((ref, query, signal, deadline) => {
        operations.push({ signal, deadline })
        return serverApi.fetchMissionCurrentBody(ref.instanceId, source, { missionID: source.missionID, ...ref.selector, ...query }, signal, deadline)
      })
      const ref: MissionBodyRef = { instanceId: "fixture", projectID: source.projectID, missionID: source.missionID, passage: source, selector: { kind: "mission", field: "notes" } }
      whole = store.use(ref, "connection"); prefix = store.use(ref, "connection")
      const rootA = await header(); whole.expect(rootA.bodies.notes, rootA.revision); whole.need(9_001); prefix.need(9_001)
      await waitFor(() => (prefix!.state().body?.text.length ?? 0) >= 9_001, "A prefix must be displayed")
      const first = prefix.state().body!; assert.equal(first.digest, da); assert.ok(first.text.length < first.characters)
      seen = observe(prefix)
      const pageTwo = missionBodyNeed(first, 1, 9_000), pageOne = missionBodyNeed(first, 0, 9_000)
      whole.need(pageTwo); prefix.need(trigger === "increase" ? 9_001 : pageOne); await started(startedA)
      await update(b, "page-b"); const rootB = await header(); whole.expect(rootB.bodies.notes, rootB.revision); releaseA(); await started(startedB)
      assert.equal(prefix.state().body?.digest, da); assert.ok(pendingOffset > first.text.length && pendingOffset < pageTwo)
      const operation = operations.at(-1)!, before = operations.length
      await update(c, "page-c"); const rootC = await header(); assert.equal(rootC.bodies.notes.digest, dc)
      assert.deepEqual((await f.read()).source, source, "notes edits preserve frozen passage identity")
      if (change === "invalidate") store.invalidate()
      else whole.expect(rootC.bodies.notes, change === "same-revision" ? rootB.revision : rootC.revision)
      if (trigger === "reduce") whole.need(pageOne)
      else { whole.release(); if (trigger === "increase") prefix.need(pageOne) }
      t.diagnostic(JSON.stringify({ owner, change, trigger, oldPrefix: first.text.length, pendingPrefix: pendingOffset, pageTwo, pageOne,
        expected: change === "invalidate" ? "invalidated" : dc, display: prefix.state().body?.digest, source: source.digest }))
      assert.equal(prefix.state().body?.digest, da, "the actual page-need helper must never newly publish B under C/invalidation")
      assert.ok(!seen.digests.includes(db)); assert.equal(operations.length, before); assert.equal(operation.signal.aborted, false)
      releaseB(); await waitFor(() => prefix!.state().status === "error", "old B or its invalidated revalidation must park with A")
      await delay(0); assert.equal(prefix.state().body?.digest, da); assert.ok(!seen.digests.includes(db))
      assert.ok(operations.length <= before + 1); assert.ok(operations.slice(1).every(read => read.deadline === operation.deadline))
      if (change === "invalidate") prefix.expect(rootC.bodies.notes, rootC.revision)
      prefix.retry(); await waitFor(() => prefix!.state().body?.digest === dc, "explicit fresh Retry must adopt real C")
      assert.equal(prefix.state().status, "ready"); assert.ok(operations.at(-1)!.deadline! > operation.deadline!)
      assert.notEqual(operations.at(-1)!.signal, operation.signal); assert.ok(!seen.digests.includes(db))
    } finally { whole?.release(); prefix?.release(); releaseA(); releaseB(); seen?.dispose(); globalThis.fetch = original; await f.dispose(); await flush() }
  })
