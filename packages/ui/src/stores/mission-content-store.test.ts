import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { createEffect, createRoot } from "solid-js"
import type { MissionContentResponse } from "../../../server/src/missions/mission-content-wire"
import { createMissionContentStore, type MissionBodyRef, type MissionBodyState } from "./mission-content-store"
import { missionMarkdownPage } from "../lib/mission-markdown-pages"
import { missionBodyCovers, missionBodyNeed } from "../lib/mission-body-pages"

const ref = (missionID = "mission", field = "objective"): MissionBodyRef => ({ instanceId: "instance", projectID: "project", missionID, selector: { kind: "mission", field } })
const digest = (text: string) => createHash("sha256").update(text, "utf16le").digest("base64url")
/** A map's descriptor of `text`. */
const describe = (text: string) => ({ characters: text.length, digest: digest(text) })
const flush = () => new Promise(resolve => setImmediate(resolve))

test("a body no descriptor describes is read again once its owner's mark changes, a read in flight under an earlier mark never shown", async () => {
  const s = server(1_000), store = createMissionContentStore(s.fetch)
  s.values.set("mission:objective", "five")
  const consumer = store.use(ref(), "connection", "mark-5"), states = observe(consumer.state)
  consumer.need(Infinity)
  await flush()
  assert.deepEqual([consumer.state().body?.text, consumer.state().body?.mark, s.reads.length], ["five", "mark-5", 1], "the first read is sent under the first mark")
  // New metadata: the body is read again; the same metadata reads nothing more.
  s.values.set("mission:objective", "six")
  consumer.version("mark-6")
  await flush()
  consumer.version("mark-6")
  await flush()
  assert.deepEqual([consumer.state().body?.text, s.reads.length], ["six", 2])
  // A read sent under mark 6 answers after mark 7 arrived: superseded, then read again.
  s.hold(true)
  consumer.retry()
  await flush()
  s.values.set("mission:objective", "seven")
  consumer.version("mark-7")
  s.hold(false)
  s.reads[2].settle()
  await flush(); await flush()
  assert.deepEqual([consumer.state().body?.text, consumer.state().body?.mark, s.reads.length], ["seven", "mark-7", 4])
  assert.ok(!states.seen.some(state => state.body?.text === "seven" && state.body.mark === "mark-6"), "the superseded answer never published")
  // A retained body shown again under another mark is read again.
  consumer.release()
  s.values.set("mission:objective", "eight")
  const again = store.use(ref(), "connection", "mark-8")
  again.need(Infinity)
  await flush()
  assert.deepEqual([again.state().body?.text, s.reads.length], ["eight", 5])
  states.dispose(); again.release()
})

/** A content route over mutable values, cutting `slice` characters per answer; each read waits for `release`. */
function server(slice = 10) {
  const values = new Map<string, string>(), revisions = new Map<string, number>()
  const reads: Array<{ missionID: string; field: string; offset: number; digest?: string; settle: () => void; aborted: () => boolean }> = []
  let held = false, unavailable: string | undefined, failing = false
  const answer = (target: MissionBodyRef, query: { digest?: string; offset: number }): MissionContentResponse => {
    if (unavailable) return { available: false, reason: unavailable } as MissionContentResponse
    const base = { available: true as const, version: 1 as const, projectID: target.projectID, missionID: target.missionID, revision: revisions.get(target.missionID) ?? 1 }
    const text = values.get(`${target.missionID}:${target.selector.field}`)
    if (text === undefined) return { ...base, refused: "content-not-found" }
    if (query.digest !== undefined && query.digest !== digest(text)) return { ...base, refused: "content-changed" }
    const end = Math.min(text.length, query.offset + slice)
    return { ...base, content: { ...target.selector, digest: digest(text), offset: query.offset, characters: text.length, text: text.slice(query.offset, end),
      ...(end < text.length ? { next: end } : {}) } }
  }
  const fetch = (target: MissionBodyRef, query: { digest?: string; offset: number }, signal: AbortSignal) => new Promise<MissionContentResponse>((resolve, reject) => {
    // The answer is computed when the read is settled: a value may change while it waits.
    const settle = () => failing ? reject(new Error("offline")) : resolve(answer(target, query))
    reads.push({ missionID: target.missionID, field: target.selector.field, ...query, settle, aborted: () => signal.aborted })
    signal.addEventListener("abort", () => reject(new Error("aborted")))
    if (!held) queueMicrotask(settle)
  })
  return {
    values, revisions, reads, fetch,
    hold: (value: boolean) => { held = value },
    unavailable: (reason: string | undefined) => { unavailable = reason },
    failing: (value: boolean) => { failing = value },
  }
}

/** Every state a consumer publishes, as an effect observes it. */
function observe(state: () => MissionBodyState) {
  const seen: MissionBodyState[] = []
  const dispose = createRoot(dispose => { createEffect(() => seen.push(state())); return dispose })
  return { seen, dispose }
}

test("a body loads slice by slice only as far as its readers need, one read at a time, shared by its readers", async () => {
  const s = server(10), store = createMissionContentStore(s.fetch)
  s.values.set("mission:objective", "0123456789abcdefghijABCDEFGHIJxyz")
  const first = store.use(ref(), "connection"), second = store.use(ref(), "connection")
  await flush()
  assert.deepEqual(s.reads.map(read => read.offset), [0], "two readers of one body share one read")
  assert.equal(first.state().body?.text, "0123456789")
  first.need(15); second.need(12)
  await flush(); await flush()
  assert.deepEqual(s.reads.map(read => read.offset), [0, 10], "only the slice the larger demand reaches")
  assert.equal(second.state().body?.text, "0123456789abcdefghij")
  assert.equal(s.reads[1].digest, digest("0123456789abcdefghijABCDEFGHIJxyz"), "a continuation repeats the first slice's digest")
  first.need(Infinity)
  await flush(); await flush(); await flush()
  assert.deepEqual(s.reads.map(read => read.offset), [0, 10, 20, 30])
  assert.deepEqual(first.state(), { status: "ready", body: { digest: digest("0123456789abcdefghijABCDEFGHIJxyz"), revision: 1, characters: 33, json: false,
    text: "0123456789abcdefghijABCDEFGHIJxyz" }, revision: 1 })
  // Shown and unchanged: demand and a known revision read nothing more.
  first.expect(undefined, 1); second.need(33)
  await flush()
  assert.equal(s.reads.length, 4, "no read without an invalidation, and no polling")
  first.release(); second.release()
})

test("a body changed between slices is never shown mixed: the continuation is refused and the new value read from its start", async () => {
  const s = server(10), store = createMissionContentStore(s.fetch)
  const before = "AAAAAAAAAA-before-tail-of-the-old-value", after = "BBBBBBBBBB-after-the-change-of-this-value"
  s.values.set("mission:objective", before)
  const reader = store.use(ref(), "connection"), states = observe(reader.state)
  await flush()
  s.values.set("mission:objective", after)
  s.revisions.set("mission", 2)
  reader.need(Infinity)
  for (let index = 0; index < 12; index++) await flush()
  assert.deepEqual(s.reads.map(read => [read.offset, read.digest === undefined ? "first" : read.digest === digest(before) ? "before" : "after"]),
    [[0, "first"], [10, "before"], [0, "first"], [10, "after"], [20, "after"], [30, "after"], [40, "after"]])
  assert.equal(reader.state().body?.text, after)
  assert.ok(states.seen.filter(state => state.body).length > 2, "the observer saw the reader's bodies")
  for (const { body } of states.seen) {
    if (!body) continue
    const whole = body.digest === digest(before) ? before : body.digest === digest(after) ? after : undefined
    assert.ok(whole && whole.startsWith(body.text), `every shown text is one value's own prefix: ${body.text}`)
  }
  states.dispose(); reader.release()
})

test("a passive refresh keeps the last good body until the newer one covers what is shown, and a failure keeps it too", async () => {
  const s = server(10), store = createMissionContentStore(s.fetch)
  s.values.set("mission:objective", "old value!")
  const reader = store.use(ref(), "connection")
  await flush()
  assert.equal(reader.state().body?.text, "old value!")
  // From the first shown body on, every published state.
  const states = observe(reader.state)
  s.values.set("mission:objective", "the new value, longer than one slice")
  s.revisions.set("mission", 2)
  reader.need(20)
  reader.expect(describe("old value!"), 1)
  await flush()
  assert.equal(s.reads.length, 1, "the body its map names needs no read")
  s.hold(true)
  reader.expect(describe("the new value, longer than one slice"), 2)
  reader.expect(describe("the new value, longer than one slice"), 2)
  assert.equal(s.reads.length, 2, "a newer body reads once, coalesced")
  s.reads[1].settle(); await flush()
  assert.equal(reader.state().body?.text, "old value!", "the newer first slice does not cover the shown prefix yet")
  s.reads[2].settle(); await flush()
  assert.equal(reader.state().body?.text, "the new value, longe")
  assert.ok(states.seen.length > 1 && states.seen.every(state => state.body), "the reader never went blank")
  // A failed refresh keeps the display and parks until demand, an invalidation or a retry.
  s.hold(false); s.failing(true)
  s.revisions.set("mission", 3)
  reader.expect(describe("a third value the map names"), 3)
  await flush(); await flush()
  assert.deepEqual([reader.state().status, reader.state().body?.text], ["error", "the new value, longe"])
  const failed = s.reads.length
  reader.need(30)
  await flush()
  assert.equal(s.reads.length, failed, "a failure stays parked")
  s.failing(false)
  reader.retry()
  await flush(); await flush(); await flush()
  assert.equal(reader.state().status, "ready")
  states.dispose(); reader.release()
})

test("a revision shown while the first slice is read is read again once if that answer predates it", async () => {
  const s = server(10), store = createMissionContentStore(s.fetch)
  s.values.set("mission:objective", "revision one")
  s.hold(true)
  const reader = store.use(ref(), "connection")
  reader.expect(describe("revision one"), 1)
  // The map moves on while the read runs; the value changes with it, after the answer was cut.
  reader.expect(describe("revision two"), 2)
  s.reads[0].settle(); await flush()
  s.values.set("mission:objective", "revision two")
  s.revisions.set("mission", 2)
  assert.equal(s.reads.length, 2, "the answer at revision 1 predates the map's revision 2")
  s.reads[1].settle(); await flush(); await flush()
  assert.equal(reader.state().body?.text, "revision t")
  assert.equal(reader.state().body?.revision, 2)
  reader.expect(describe("revision two"), 2)
  await flush()
  assert.equal(s.reads.length, 2, "an answer of the shown body is final")
  reader.release()
})

test("a shown body is read again only when its map's descriptor names another digest, never for unrelated revisions", async () => {
  const s = server(10), store = createMissionContentStore(s.fetch)
  s.values.set("mission:objective", "stable objective")
  const reader = store.use(ref(), "connection")
  reader.need(Infinity)
  for (let index = 0; index < 4; index++) await flush()
  reader.expect(describe("stable objective"), 1)
  const settled = s.reads.length
  // Twenty unrelated revisions (task declarations, say) leave the body's descriptor alone.
  for (let revision = 2; revision <= 21; revision++) { s.revisions.set("mission", revision); reader.expect(describe("stable objective"), revision); await flush() }
  assert.equal(s.reads.length, settled, "unchanged bodies are not read again")
  // A retained body whose digest the newer map does not name is read again, though it is whole.
  reader.release()
  s.values.set("mission:objective", "an edited objective"); s.revisions.set("mission", 22)
  const reopened = store.use(ref(), "connection")
  reopened.need(Infinity)
  assert.equal(reopened.state().body?.text, "stable objective", "the retained body shows meanwhile")
  reopened.expect(describe("an edited objective"), 22)
  for (let index = 0; index < 6; index++) await flush()
  assert.equal(reopened.state().body?.text, "an edited objective")
  assert.ok(s.reads.length > settled)
  reopened.release()
})

for (const trigger of ["instance", "every instance"] as const) for (const outcome of ["unavailable", "rejected"] as const) {
  test(`a recovery invalidation (${trigger}) during a request survives its ${outcome} answer: one fresh read follows`, async () => {
    const answers: Array<() => Promise<MissionContentResponse>> = []
    let calls = 0, finish!: () => void
    const store = createMissionContentStore((target, query) => {
      calls++
      return answers.shift()?.() ?? Promise.resolve({ available: true, version: 1, projectID: target.projectID, missionID: target.missionID, revision: 1,
        content: { ...target.selector, digest: digest("recovered"), offset: query.offset, characters: 9, text: "recovered" } } as MissionContentResponse)
    })
    answers.push(() => new Promise((resolve, reject) => {
      finish = outcome === "rejected" ? () => reject(new Error("old connection failed")) : () => resolve({ available: false, reason: "plugin-unavailable" } as MissionContentResponse)
    }))
    const reader = store.use(ref(), "connection")
    reader.need(Infinity)
    if (trigger === "instance") store.invalidate("instance"); else store.invalidate()
    finish()
    for (let index = 0; index < 4; index++) await flush()
    assert.deepEqual([calls, reader.state().status, reader.state().body?.text], [2, "ready", "recovered"])
    // A fresh read that fails without a newer invalidation parks as usual.
    answers.push(() => Promise.reject(new Error("still offline")))
    store.invalidate("instance")
    for (let index = 0; index < 4; index++) await flush()
    assert.deepEqual([calls, reader.state().status, reader.state().body?.text], [3, "error", "recovered"])
    reader.need(5)
    await flush()
    assert.equal(calls, 3, "parked")
    reader.release()
  })
}

test("a retry after a parked failure shows the retained body while it reads, and a continuation retry resumes the same value", async () => {
  const s = server(10), store = createMissionContentStore(s.fetch)
  s.values.set("mission:objective", "0123456789abcdefghijKLMNOPQRST")
  const reader = store.use(ref(), "connection")
  await flush()
  s.failing(true)
  reader.need(Infinity)
  for (let index = 0; index < 3; index++) await flush()
  assert.deepEqual([reader.state().status, reader.state().body?.text], ["error", "0123456789"], "a failed continuation keeps the page")
  s.failing(false); s.hold(true)
  reader.retry()
  assert.deepEqual([reader.state().status, reader.state().body?.text], ["ready", "0123456789"], "reading again, never still failed")
  s.hold(false)
  s.reads.at(-1)!.settle()
  for (let index = 0; index < 6; index++) await flush()
  assert.deepEqual([reader.state().status, reader.state().body?.text], ["ready", "0123456789abcdefghijKLMNOPQRST"])
  reader.release()
})

test("late answers never publish across a mission switch, a released reader or another connection", async () => {
  const s = server(10), store = createMissionContentStore(s.fetch)
  s.values.set("a:objective", "mission A objective")
  s.values.set("b:objective", "mission B objective")
  s.hold(true)
  const a = store.use(ref("a"), "connection"), aStates = observe(a.state)
  // The reader switches to B before A answers.
  a.release()
  const b = store.use(ref("b"), "connection"), aborted = s.reads[0].aborted()
  s.reads[0].settle(); s.reads[1].settle(); await flush()
  assert.ok(aStates.seen.length > 0 && aStates.seen.every(state => !state.body), "A's late answer never published")
  assert.ok(aborted, "the released read is cancelled")
  assert.equal(b.state().body?.text, "mission B ")
  // Another connection (instance, folder or native generation) starts again.
  const moved = store.use(ref("b"), "other-connection")
  assert.equal(moved.state().body, undefined)
  assert.equal(s.reads.length, 3)
  s.reads[2].settle(); await flush()
  assert.equal(moved.state().body?.text, "mission B ")
  aStates.dispose(); b.release(); moved.release()
})

test("a map naming no descriptor of a shown body expects nothing: newer revisions alone read nothing", async () => {
  const s = server(10), store = createMissionContentStore(s.fetch)
  s.values.set("mission:objective", "a shown body")
  const reader = store.use(ref(), "connection")
  reader.need(Infinity)
  for (let index = 0; index < 4; index++) await flush()
  const settled = s.reads.length
  for (let revision = 2; revision <= 6; revision++) { s.revisions.set("mission", revision); reader.expect(undefined, revision); await flush() }
  assert.equal(s.reads.length, settled, "only a descriptor's digest reads a body again")
  assert.equal(reader.state().body?.text, "a shown body")
  reader.release()
})

test("a plugin without content reads fails until Retry, a missing body and a stopped workspace answer once each", async () => {
  const s = server(10), store = createMissionContentStore(s.fetch)
  s.unavailable("plugin-unavailable")
  s.values.set("mission:objective", "objective")
  const old = store.use(ref(), "connection")
  await flush(); await flush()
  assert.deepEqual([old.state().status, s.reads.length], ["error", 1], "a failure, parked: nothing is read again meanwhile")
  old.need(Infinity)
  await flush()
  assert.equal(s.reads.length, 1)
  s.unavailable(undefined)
  old.retry()
  await flush(); await flush()
  assert.deepEqual([old.state().status, old.state().body?.text, s.reads.length], ["ready", "objective", 2], "Retry reads it once the plugin answers")
  old.release()
  const missing = store.use(ref("mission", "summary"), "connection")
  await flush(); await flush()
  assert.deepEqual([missing.state().status, s.reads.length], ["missing", 3])
  missing.release()
  s.values.set("mission:notes", "notes")
  const shown = store.use(ref("mission", "notes"), "connection")
  await flush()
  store.clear("instance")
  assert.deepEqual(shown.state(), { status: "error" })
  shown.release()
})

test("bodies no reader shows stay within the byte budget, least recently used first out; shown ones always stay", async () => {
  const s = server(1_000), budget = 2 * 10 * 100, store = createMissionContentStore(s.fetch, budget)
  const shown = store.use(ref("shown"), "connection")
  s.values.set("shown:objective", "s".repeat(100))
  for (let index = 0; index < 30; index++) {
    s.values.set(`m${index}:objective`, String(index).padEnd(100, "x"))
    const reader = store.use(ref(`m${index}`), "connection")
    await flush()
    reader.release()
    assert.ok(store.retainedBytes() <= budget, `${store.retainedBytes()} bytes after ${index + 1} bodies`)
  }
  assert.equal(store.retainedBytes(), budget)
  await flush()
  assert.equal(shown.state().body?.text, "s".repeat(100), "a shown body is never evicted")
  const reads = s.reads.length
  const recent = store.use(ref("m29"), "connection"), evicted = store.use(ref("m0"), "connection")
  assert.equal(recent.state().body?.text.slice(0, 2), "29", "a retained body redisplays at once")
  assert.equal(evicted.state().body, undefined)
  await flush()
  assert.equal(s.reads.length, reads + 1, "only the evicted body is read again")
  recent.release(); evicted.release(); shown.release()
})

test("a reader page from a covering prefix is exactly the whole text's page", () => {
  const texts = ["plain ".repeat(4_000), `intro\n\`\`\`ts\n${"code();\n".repeat(3_000)}\`\`\`\nafter\n${"tail ".repeat(2_000)}`,
    `${"x".repeat(8_999)}\n~~~\n${"y".repeat(20_000)}\n~~~\nend`, `${"😀".repeat(9_000)}`, `${"line\n".repeat(5_000)}${"z".repeat(30_000)}`,
    // Inside a fence, a line that opens like a closer but continues past the page end.
    `\`\`\`\n\`\`\`${"a".repeat(20_000)}\n\`\`\`\nend`]
  for (const text of texts) {
    for (let page = 0; page < Math.ceil(text.length / 9_000); page++) {
      for (const slice of [997, 9_000, 25_000]) {
        let loaded = ""
        while (!missionBodyCovers(loaded, text.length, page, 9_000)) {
          const need = missionBodyNeed({ text: loaded, characters: text.length }, page, 9_000)
          assert.ok(need > loaded.length, "an uncovered page always asks for more")
          loaded = text.slice(0, Math.min(text.length, loaded.length + slice))
        }
        assert.deepEqual(missionMarkdownPage(loaded, page, 9_000), missionMarkdownPage(text, page, 9_000), `page ${page} of ${text.length} in slices of ${slice}`)
      }
    }
  }
})
